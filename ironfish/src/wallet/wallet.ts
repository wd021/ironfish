/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { generateKey, generateNewPublicAddress } from '@ironfish/rust-nodejs'
import cluster from 'cluster'
import os from 'os'
import process from 'process'
import { v4 as uuid } from 'uuid'
import { Assert } from '../assert'
import { Blockchain } from '../blockchain'
import { ChainProcessor } from '../chainProcessor'
import { Event } from '../event'
import { Config } from '../fileStores'
import { createRootLogger, Logger } from '../logger'
import { MemPool } from '../memPool'
import { NoteWitness } from '../merkletree/witness'
import { Mutex } from '../mutex'
import { Note } from '../primitives/note'
import { Transaction } from '../primitives/transaction'
import { ValidationError } from '../rpc/adapters/errors'
import { IDatabaseTransaction } from '../storage/database/transaction'
import { BufferUtils, PromiseResolve, PromiseUtils, SetTimeoutToken } from '../utils'
import { WorkerPool } from '../workerPool'
import { DecryptedNote, DecryptNoteOptions } from '../workerPool/tasks/decryptNotes'
import { Account } from './account'
import { AccountsDB } from './database/accountsdb'
import { AccountValue } from './database/accountValue'
import { validateAccount } from './validator'

const BLOCKS_TO_FETCH = 2000

export type SyncTransactionParams =
  // Used when receiving a transaction from a block with notes
  // that have been added to the trees
  | { blockHash: Buffer; initialNoteIndex: number; sequence: number }
  // Used if the transaction is not yet part of the chain
  | { submittedSequence: number }
  | Record<string, never>

export class Accounts {
  readonly onAccountImported = new Event<[account: Account]>()
  readonly onAccountRemoved = new Event<[account: Account]>()
  readonly onBroadcastTransaction = new Event<[transaction: Transaction]>()
  readonly onTransactionCreated = new Event<[transaction: Transaction]>()

  scan: ScanState | null = null
  scanB: ScanState | null = null
  updateHeadState: ScanState | null = null

  protected readonly headHashes = new Map<string, Buffer | null>()

  protected readonly accounts = new Map<string, Account>()
  readonly db: AccountsDB
  readonly logger: Logger
  readonly workerPool: WorkerPool
  readonly chain: Blockchain
  readonly chainProcessor: ChainProcessor
  private readonly config: Config

  protected rebroadcastAfter: number
  protected defaultAccount: string | null = null
  protected isStarted = false
  protected isOpen = false
  protected eventLoopTimeout: SetTimeoutToken | null = null
  private readonly createTransactionMutex: Mutex

  constructor({
    chain,
    config,
    database,
    logger = createRootLogger(),
    rebroadcastAfter,
    workerPool,
  }: {
    chain: Blockchain
    config: Config
    database: AccountsDB
    logger?: Logger
    rebroadcastAfter?: number
    workerPool: WorkerPool
  }) {
    this.chain = chain
    this.config = config
    this.logger = logger.withTag('accounts')
    this.db = database
    this.workerPool = workerPool
    this.rebroadcastAfter = rebroadcastAfter ?? 10
    this.createTransactionMutex = new Mutex()

    this.chainProcessor = new ChainProcessor({
      logger: this.logger,
      chain: chain,
      head: null,
    })

    this.chainProcessor.onAdd.on(async (header) => {
      this.logger.debug(`AccountHead ADD: ${Number(header.sequence) - 1} => ${header.sequence}`)

      for await (const {
        transaction,
        blockHash,
        sequence,
        initialNoteIndex,
      } of this.chain.iterateBlockTransactions(header)) {
        await this.syncTransaction(transaction, {
          blockHash,
          initialNoteIndex,
          sequence,
        })
      }

      await this.updateHeadHashes(header.hash)
    })

    this.chainProcessor.onRemove.on(async (header) => {
      this.logger.debug(`AccountHead DEL: ${header.sequence} => ${Number(header.sequence) - 1}`)

      for await (const { transaction } of this.chain.iterateBlockTransactions(header)) {
        await this.syncTransaction(transaction, {})
      }

      await this.updateHeadHashes(header.previousBlockHash)
    })
  }

  async updateHead(): Promise<void> {
    if (this.scan || this.updateHeadState) {
      return
    }

    // TODO: this isn't right, as the scan state doesn't get its sequence or
    // endSequence set properly
    const scan = new ScanState()
    this.updateHeadState = scan

    try {
      const { hashChanged } = await this.chainProcessor.update({
        signal: scan.abortController.signal,
      })

      if (hashChanged) {
        this.logger.debug(
          `Updated Accounts Head: ${String(this.chainProcessor.hash?.toString('hex'))}`,
        )
      }
    } finally {
      scan.signalComplete()
      this.updateHeadState = null
    }
  }

  get shouldRescan(): boolean {
    if (this.scan) {
      return false
    }

    for (const account of this.accounts.values()) {
      if (!this.isAccountUpToDate(account)) {
        return true
      }
    }

    return false
  }

  async open(): Promise<void> {
    if (this.isOpen) {
      return
    }

    this.isOpen = true
    await this.db.open()
    await this.load()
  }

  private async load(): Promise<void> {
    for await (const { id, serializedAccount } of this.db.loadAccounts()) {
      const account = new Account({
        ...serializedAccount,
        id,
        accountsDb: this.db,
      })

      this.accounts.set(id, account)
      await account.load()
    }

    const meta = await this.db.loadAccountsMeta()
    this.defaultAccount = meta.defaultAccountId

    for await (const { accountId, headHash } of this.db.loadHeadHashes()) {
      this.headHashes.set(accountId, headHash)
    }

    this.chainProcessor.hash = await this.getLatestHeadHash()
  }

  private unload(): void {
    for (const account of this.accounts.values()) {
      account.unload()
    }

    this.accounts.clear()
    this.headHashes.clear()

    this.defaultAccount = null
    this.chainProcessor.hash = null
  }

  async close(): Promise<void> {
    if (!this.isOpen) {
      return
    }

    this.isOpen = false
    await this.db.close()
    this.unload()
  }

  async start(): Promise<void> {
    if (this.isStarted) {
      return
    }
    this.isStarted = true

    if (this.chainProcessor.hash) {
      const hasHeadBlock = await this.chain.hasBlock(this.chainProcessor.hash)

      if (!hasHeadBlock) {
        this.logger.error(
          `Resetting accounts database because accounts head was not found in chain: ${this.chainProcessor.hash.toString(
            'hex',
          )}`,
        )
        await this.reset()
      }
    }

    if (this.shouldRescan && !this.scan) {
      void this.scanTransactions()
    }

    void this.eventLoop()
  }

  async stop(): Promise<void> {
    if (!this.isStarted) {
      return
    }
    this.isStarted = false

    if (this.eventLoopTimeout) {
      clearTimeout(this.eventLoopTimeout)
    }

    await Promise.all([this.scan?.abort(), this.updateHeadState?.abort()])

    if (this.db.database.isOpen) {
      await this.updateHeadHashes(this.chainProcessor.hash)
    }
  }

  async eventLoop(): Promise<void> {
    if (!this.isStarted) {
      return
    }

    await this.updateHead()
    await this.expireTransactions()
    await this.rebroadcastTransactions()

    if (this.isStarted) {
      this.eventLoopTimeout = setTimeout(() => void this.eventLoop(), 1000)
    }
  }

  async updateHeadHashes(headHash: Buffer | null, tx?: IDatabaseTransaction): Promise<void> {
    let accounts = this.listAccounts()

    if (headHash) {
      accounts = accounts.filter((a) => this.isAccountUpToDate(a))
    }

    await this.db.database.withTransaction(tx, async (tx) => {
      for (const account of accounts) {
        await this.updateHeadHash(account, headHash, tx)
      }
    })
  }

  async updateHeadHash(
    account: Account,
    headHash: Buffer | null,
    tx?: IDatabaseTransaction,
  ): Promise<void> {
    this.headHashes.set(account.id, headHash)

    await this.db.saveHeadHash(account, headHash, tx)
  }

  async reset(): Promise<void> {
    await this.db.database.transaction(async (tx) => {
      await this.resetAccounts(tx)
      await this.updateHeadHashes(null, tx)
    })

    this.chainProcessor.hash = null
  }

  private async resetAccounts(tx?: IDatabaseTransaction): Promise<void> {
    for (const account of this.accounts.values()) {
      await account.reset(tx)
    }
  }

  private async decryptNotes(
    transaction: Transaction,
    initialNoteIndex: number | null,
    accounts?: Array<Account>,
  ): Promise<Map<string, Array<DecryptedNote>>> {
    const accountsToCheck =
      accounts || this.listAccounts().filter((a) => this.isAccountUpToDate(a))

    const decryptedNotesByAccountId = new Map<string, Array<DecryptedNote>>()

    const batchSize = 20
    for (const account of accountsToCheck) {
      const decryptedNotes = []
      let decryptNotesPayloads = []
      let currentNoteIndex = initialNoteIndex

      for (const note of transaction.notes()) {
        decryptNotesPayloads.push({
          serializedNote: note.serialize(),
          incomingViewKey: account.incomingViewKey,
          outgoingViewKey: account.outgoingViewKey,
          spendingKey: account.spendingKey,
          currentNoteIndex,
        })

        if (currentNoteIndex) {
          currentNoteIndex++
        }

        if (decryptNotesPayloads.length >= batchSize) {
          const decryptedNotesBatch = await this.decryptNotesFromTransaction(
            decryptNotesPayloads,
          )
          decryptedNotes.push(...decryptedNotesBatch)
          decryptNotesPayloads = []
        }
      }

      if (decryptNotesPayloads.length) {
        const decryptedNotesBatch = await this.decryptNotesFromTransaction(decryptNotesPayloads)
        decryptedNotes.push(...decryptedNotesBatch)
      }

      if (decryptedNotes.length) {
        decryptedNotesByAccountId.set(account.id, decryptedNotes)
      }
    }

    return decryptedNotesByAccountId
  }

  private async decryptNotesFromTransaction(
    decryptNotesPayloads: Array<DecryptNoteOptions>,
  ): Promise<Array<DecryptedNote>> {
    const decryptedNotes = []
    const response = await this.workerPool.decryptNotes(decryptNotesPayloads)
    for (const decryptedNote of response) {
      if (decryptedNote) {
        decryptedNotes.push(decryptedNote)
      }
    }

    return decryptedNotes
  }

  /**
   * Called:
   *  - Called when transactions are added to the mem pool
   *  - Called for transactions on disconnected blocks
   *  - Called when transactions are added to a block on the genesis chain
   */
  async syncTransaction(
    transaction: Transaction,
    params: SyncTransactionParams,
    accounts?: Array<Account>,
  ): Promise<void> {
    const initialNoteIndex = 'initialNoteIndex' in params ? params.initialNoteIndex : null

    await transaction.withReference(async () => {
      const decryptedNotesByAccountId = await this.decryptNotes(
        transaction,
        initialNoteIndex,
        accounts,
      )

      for (const [accountId, decryptedNotes] of decryptedNotesByAccountId) {
        const account = this.accounts.get(accountId)
        Assert.isNotUndefined(account, `syncTransaction: No account found for ${accountId}`)
        await account.syncTransaction(transaction, decryptedNotes, params)
      }
    })
  }

  /**
   * Deletes a transaction from the transaction map and updates
   * the related maps.
   */
  async deleteTransaction(transaction: Transaction): Promise<void> {
    for (const account of this.accounts.values()) {
      await account.deleteTransaction(transaction)
    }
  }

  async scanTransactions(): Promise<void> {
    if (!this.isOpen) {
      throw new Error('Cannot start a scan if accounts are not loaded')
    }

    if (this.scan) {
      this.logger.info('Skipping Scan, already scanning.')
      return
    }

    const scan = new ScanState()
    this.scan = scan

    // If we are updating the account head, we need to wait until its finished
    // but setting this.scan is our lock so updating the head doesn't run again
    await this.updateHeadState?.wait()

    let startHash = await this.getEarliestHeadHash()
    if (!startHash) {
      startHash = this.chain.genesis.hash
    }
    const startHeader = await this.chain.getHeader(startHash)
    Assert.isNotNull(
      startHeader,
      `scanTransactions: No header found for start hash ${startHash.toString('hex')}`,
    )

    const endHash = this.chainProcessor.hash || this.chain.head.hash
    const endHeader = await this.chain.getHeader(endHash)
    Assert.isNotNull(
      endHeader,
      `scanTransactions: No header found for end hash ${endHash.toString('hex')}`,
    )

    scan.sequence = startHeader.sequence
    scan.endSequence = endHeader.sequence

    // Accounts that need to be updated at the current scan sequence
    const accounts: Array<Account> = []
    // Accounts that need to be updated at future scan sequences
    let remainingAccounts: Array<Account> = []

    for (const account of this.accounts.values()) {
      const headHash = this.headHashes.get(account.id)
      Assert.isNotUndefined(
        headHash,
        `scanTransactions: No head hash found for ${account.displayName}`,
      )

      if (BufferUtils.equalsNullable(startHash, headHash)) {
        accounts.push(account)
      } else if (!this.isAccountUpToDate(account)) {
        remainingAccounts.push(account)
      }
    }

    if (scan.isAborted) {
      scan.signalComplete()
      this.scan = null
      return
    }

    this.logger.info(
      `Scan starting from earliest found account head hash: ${startHash.toString('hex')}`,
    )
    this.logger.info(`Accounts to scan for: ${accounts.map((a) => a.displayName).join(', ')}`)

    // Go through every transaction in the chain and add notes that we can decrypt
    for await (const blockHeader of this.chain.iterateBlockHeaders(
      startHash,
      endHash,
      undefined,
      false,
    )) {
      for await (const {
        blockHash,
        transaction,
        initialNoteIndex,
        sequence,
      } of this.chain.iterateBlockTransactions(blockHeader)) {
        if (scan.isAborted) {
          scan.signalComplete()
          this.scan = null
          return
        }

        await this.syncTransaction(
          transaction,
          {
            blockHash,
            initialNoteIndex,
            sequence,
          },
          accounts,
        )

        scan.signal(sequence)
      }

      for (const account of accounts) {
        await this.updateHeadHash(account, blockHeader.hash)
      }

      const newRemainingAccounts = []

      for (const remainingAccount of remainingAccounts) {
        const headHash = this.headHashes.get(remainingAccount.id)
        Assert.isNotUndefined(
          headHash,
          `scanTransactions: No head hash found for remaining account ${remainingAccount.displayName}`,
        )

        if (BufferUtils.equalsNullable(headHash, blockHeader.hash)) {
          accounts.push(remainingAccount)
          this.logger.debug(`Adding ${remainingAccount.displayName} to scan`)
        } else {
          newRemainingAccounts.push(remainingAccount)
        }
      }

      remainingAccounts = newRemainingAccounts
    }

    if (this.chainProcessor.hash === null) {
      const latestHeadHash = await this.getLatestHeadHash()
      Assert.isNotNull(latestHeadHash, `scanTransactions: No latest head hash found`)

      this.chainProcessor.hash = latestHeadHash
    }

    this.logger.info(
      `Finished scanning for transactions after ${Math.floor(
        (Date.now() - scan.startedAt) / 1000,
      )} seconds`,
    )

    scan.signalComplete()
    this.scan = null
  }

  async scanTransactionFromBlockToBlock(
    id: string,
    startHash: Buffer,
    endHash: Buffer,
    accounts: Array<Account>,
    scanB: ScanState,
  ): Promise<void> {
    scanB.onTransactionHack.emit(`${id} (start) - ${startHash.toString('hex')}`)
    let i = 0

    for await (const blockHeader of this.chain.iterateBlockHeaders(
      startHash,
      endHash,
      undefined,
      false,
    )) {
      i++

      for await (const {
        blockHash,
        transaction,
        initialNoteIndex,
        sequence,
      } of this.chain.iterateBlockTransactions(blockHeader)) {
        await this.syncTransaction(
          transaction,
          {
            blockHash,
            initialNoteIndex,
            sequence,
          },
          accounts,
        )
      }

      if (i % 10 === 0) {
        scanB.onTransactionHack.emit(`${id} (progress txs) - ${(i / BLOCKS_TO_FETCH) * 100}%`)
      }
    }

    scanB.onTransactionHack.emit(`${id} (end)`)
  }

  async scanTransactionsHack(accountNames: Array<string>): Promise<void> {
    const cpus = os.cpus
    const numCPUs = cpus().length

    if (!this.isOpen) {
      throw new Error('Cannot start a scan if accounts are not loaded')
    }

    const accounts: Array<Account> = []

    for (const accountName of accountNames) {
      const account = this.getAccountByName(accountName)
      Assert.isNotNull(account, `account not null`)
      accounts.push(account)
    }

    const scanB = new ScanState()
    this.scanB = scanB

    scanB.onTransactionHack.emit(
      `(start scan) ${accountNames.toString().split(',').join(', ')}`,
    )
    scanB.onTransactionHack.emit(
      `(start scan) PID ${process.pid} is running, numCPUs ${numCPUs}`,
    )

    const blocksToFetch: { id: string; startHash: string; endHash: string }[] = [
      {
        id: '[block 0 to 2k]',
        startHash: '69e263e931fa1a2a4b0437a8eff79ffb7a353b6384a7aeac9f90ac12ae4811ef',
        endHash: '0000000000050c8f12db34eb0b5e8f1fb615bd343c283c85faa14214651ca0d0',
      },
      {
        id: '[block 2k to 4k]',
        startHash: '00000000000aed16675b31e2b2f51f8c9f43bd25893bed9cd75b85ea3b17c37c',
        endHash: '000000000004f2d6142302dcebde784d234a20fba3bdf8a898c80b420b798039',
      },
      {
        id: '[block 4k to 6k]',
        startHash: '00000000000ef8e3715fa2687a0a0b89c508768c1757759ecf429b61a77366e0',
        endHash: '000000000001e6cee4ecb35ed588063ea16000fdcadf27fe44a69dd9561c721c',
      },
      {
        id: '[block 6k to 8k]',
        startHash: '000000000015c75abdf4cae689d0092db39a5b773d778e98dac02362af37b6bd',
        endHash: '00000000000c4f16a2cb9b4f5c1ced9f5609d077895b9b75637143310e475967',
      },
      {
        id: '[block 8k to 10k]',
        startHash: '0000000000115d28e5cb3310ddbd08fa6d676875282ceaf63227985ad493b2cc',
        endHash: '00000000000d144c7b39fa29d9c258d2022f5891f02a8382d26c054f835412c9',
      },
      {
        id: '[block 10k to 12k]',
        startHash: '00000000000f27430eec3023a7d824d4013d9feba91ed6744d6fa14df523ee05',
        endHash: '00000000000705066dc88b8d0ab0e25da1aae1ebf6d3cb8903fc3f53b85459c4',
      },
      {
        id: '[block 12k to 14k]',
        startHash: '000000000005d20386e167a2c0cf4f11db6a615c64ff533c0a3ccc1cc61652a4',
        endHash: '00000000000213cff4fb7f102c87722a6e5581649f69e79c2b2da4bca84db241',
      },
      {
        id: '[block 14k to 16k]',
        startHash: '00000000000adb79e9cea4d6672c1dd3abf84459359694977daf1de891b68c24',
        endHash: '00000000000b3fbd14dd5199a0c3cda87c66c82b82a5327d2a6e9bf20d582ae2',
      },
      {
        id: '[block 16k to 18k]',
        startHash: '000000000001782d45c48483b074225505a9c61e371d44267af70a8f0307e547',
        endHash: '000000000006c553e3336c9420e816dab007cda814cb4c1d23aa32400ccc0581',
      },
      {
        id: '[block 18k to 20k]',
        startHash: '000000000001a8084bf1d698e4b4a9374fb476aa4a61066dfb0fa46e3425c149',
        endHash: '00000000000ce9db255815e2704416bc0f352561546aa7dbe442ec429416b66e',
      },
      {
        id: '[block 20k to 22k]',
        startHash: '00000000000a52144d99eff94fd83045b9530781164f882bd0a1630d99cd5059',
        endHash: '000000000007463c6ab54b9108d0781090af4ba97403108690dd630cd6f62cde',
      },
      {
        id: '[block 22k to 24k]',
        startHash: '00000000000d90cb4db91ad12f86e8acd6aab9c1fec1f5ab0de286b5f4227d49',
        endHash: '00000000000bea51732c8115279c19a1d94561ae2c8b7e354f60791b9aecca84',
      },
      {
        id: '[block 24k to 26k]',
        startHash: '0000000000043444358c73ad12d25ba970bb41008688e782a547137e43db4dcb',
        endHash: '00000000000a9c335eb7ed7e0fcfbb2244857d3de231da7696a7d64897d74a71',
      },
      {
        id: '[block 26k to 28k]',
        startHash: '000000000004ae4c07c948a149cea97ab788996e24ed7725d504525d38400cf1',
        endHash: '0000000000028abb937b2d04f8cfa0ac099f92a575c4469af0d2b18a870378d9',
      },
      {
        id: '[block 28k to 30k]',
        startHash: '00000000000affdb02ec69d234368d5460ea2a9dc56280436dffa784412bb203',
        endHash: '00000000000af457de1562bb6e1dac3f2f38de19678590d52a96f05ab543a319',
      },
      {
        id: '[block 30k to 32k]',
        startHash: '0000000000095a4d57db4a676bdf76963538489ab01bbeabb773d8945b0ab644',
        endHash: '0000000000028a834bae19fcd6e6ecca6d7a5a1ef2deb0e07c9a03dbadab3cde',
      },
      {
        id: '[block 32k to 34k]',
        startHash: '000000000002db776e282f7821179359860bc99ede9bd8e15ccd03ceac992a24',
        endHash: '0000000000070335b8a90246029c8565dc80ec1bc1e05b7a1962cdd697a84f15',
      },
      {
        id: '[block 34k to 36k]',
        startHash: '000000000005a196b18bd3ffe28346610ba35f1073c76fe49a2d4be53dfe22e7',
        endHash: '00000000000886e13b760f4226c01856f5a01f7bcaddb209a96ab2014312f2f8',
      },
      {
        id: '[block 36k to 38k]',
        startHash: '00000000000349e480afe81a96995497d28402a678f8055dd44b2f9be5b7a81a',
        endHash: '0000000000048b68fc031ee8ae3f9d68216e599ca5c18e5c8506ec42052b9002',
      },
      {
        id: '[block 38k to 40k]',
        startHash: '00000000000819d0e52fb829bc3a9c7780ec7fffc99fd279c14347642007a756',
        endHash: '00000000000365c92e472566421310cc3e1973059fe2ce9bfffafce597b01926',
      },
      {
        id: '[block 40k to 42k]',
        startHash: '000000000006f6f371a8934e274274808ee87d5100a820ea6297119bb718ea8c',
        endHash: '000000000003b76950aaaca603ba7f9d08d0a9fcdd75dce120e22b5babaf43c8',
      },
      {
        id: '[block 42k to 44k]',
        startHash: '0000000000001c41bb6c7ffa428ac8fa3ff8af731bf3d64c4f5579ebba415769',
        endHash: '000000000003e04f72d0a502796552005a8002b8801b2e7c72015c4e5dab3a06',
      },
      {
        id: '[block 44k to 46k]',
        startHash: '000000000006ea2091e960a42b5d47de23b835c8ead4f70e3efed7abaca1e16c',
        endHash: '00000000000472c9d0125beb1355281e9eefbb3e17de1766d7b817fbbb90dfcf',
      },
      {
        id: '[block 46k to 48k]',
        startHash: '000000000001ca76eaa35c2bb9a5237098a4f12a9c5d9e3fe674e566aef0bf1d',
        endHash: '0000000000057c63245799883b41d73f96fafc34e3fce3f52cf12160ea1b4adf',
      },
      {
        id: '[block 48k to 50k]',
        startHash: '0000000000044c54e30fd944c62cf47a50e1383d189f710834f644b381bc1b92',
        endHash: '000000000001fd44695ecaff812501a1a7472a20d089e3f8406cdd117833aaf4',
      },
      {
        id: '[block 50k to 52k]',
        startHash: '00000000000169af615eb8127a3ca012945941facf6c9a877da26d2ed06fc589',
        endHash: '000000000009c10cc12f66611edafff9dc6620312c1eaa725d2920d3b4cd994a',
      },
      {
        id: '[block 52k to 54k]',
        startHash: '0000000000012dec12b810f038002074fabba15c39d2c00b4fd016a88a68470c',
        endHash: '0000000000043b2bd190789e3332a28d2a8c329f81e2cf988d8db47662e3bbaa',
      },
      {
        id: '[block 54k to 56k]',
        startHash: '0000000000023e8f1612cbae6da9bfa6a602336455f961818465d50a01ebfd50',
        endHash: '000000000005372b35b41e2c6ad48d5b99213b16614fd2c82a9352c5f8eeaf8d',
      },
      {
        id: '[block 56k to 58k]',
        startHash: '0000000000064d44ae382e7fe84667480de99a0f726949ab4076c8b35f9e8408',
        endHash: '0000000000097fe254f015429f879699548b7435f6bfdcb4eb51abf31146ca0e',
      },
      {
        id: '[block 58k to 60k]',
        startHash: '000000000008dc19f9d5989af71b3280e95f48119d3ba410146307cd7788a7c1',
        endHash: '0000000000043fc59a2c26f72f67d446e384606b719147b463f5e1d080c7b8f5',
      },
      {
        id: '[block 60k to 62k]',
        startHash: '000000000003c79596fa7bc2f173fdf66a8d98614d67fa9c3854572b5665a128',
        endHash: '00000000000721aacbc9f0c6d0920fd1e3cf69ed88402a483c344521b4e52a5f',
      },
      {
        id: '[block 62k to 64k]',
        startHash: '000000000004155cc891da4bc7fa3d45ce8ff68ca4a5ba6df920cec1212fe8b2',
        endHash: '00000000000541c7f9db1bad802ddee2521ca0a7b44e07392969a333b4682e98',
      },
      {
        id: '[block 64k to 66k]',
        startHash: '0000000000096b33b816ff4b49ca6d8f492e383f5fd76079c750e026b26dfb1d',
        endHash: '0000000000039b1d25e2d5aa059fa4adc4e27e9393b20da8506a97f50db1a775',
      },
      {
        id: '[block 66k to 68k]',
        startHash: '0000000000099f7bcf227cea0c9d8f191d64042f8fe2b2f5658df5a3aa4aae4e',
        endHash: '0000000000014e41df908ca29f56d8b58b065840c688c88eb31503c2fdef75e2',
      },
      {
        id: '[block 68k to 70k]',
        startHash: '0000000000069efc2cae12203dbfd92c2fc98409a9ca7e7096093a0a56edb7a7',
        endHash: '00000000000774b7abcddae9f7c6b88909399547b2a97b7016fa925825934860',
      },
      {
        id: '[block 70k to 72k]',
        startHash: '00000000000c84595d274689d6be0382a6592ee55c6488f7e043f560de535d3d',
        endHash: '000000000009a6babbdd69239c4a04b92df5d824472e7e56640d4c64308a67ea',
      },
      {
        id: '[block 72k to 74k]',
        startHash: '000000000005f63ffd02948de8a2e68314f509a1b7ae4f3b9c3972959b75e54a',
        endHash: '0000000000014d3e6a7d923f85a2b0f0f8fd0720f36a802086422ac09b6cbf9b',
      },
      {
        id: '[block 74k to 76k]',
        startHash: '0000000000050d788f083ce7b8c3b540a7ccaf919e0e5338e7bfbb4af09f7873',
        endHash: '000000000004b24b25e6de671547227ff65edfdaaad20498042b7521417ffe75',
      },
      {
        id: '[block 76k to 78k]',
        startHash: '000000000009acac47ee1e202c9718a9712dd2ad369eb09788bafa113c4a2586',
        endHash: '0000000000082ed98577fb06ff7f8b375fe9fec230cb302a09321b8ed3e25adc',
      },
      {
        id: '[block 78k to 80k]',
        startHash: '00000000000a85127eb6aba2f9c6ea1b783b40e39b79ea54edbe63d8cc6bfdfc',
        endHash: '000000000004ef6adf764a764b5680e896142763d2f952845c1c67b55da0e2b6',
      },
      {
        id: '[block 80k to 82k]',
        startHash: '00000000000110fbec1574bfd8538994f331da45f01959a0aa099a57e3a9704a',
        endHash: '0000000000055bd6b2e5bf1763a390a5f8a92508cc05e8eb624e057c54a332e5',
      },
      {
        id: '[block 82k to 84k]',
        startHash: '00000000000a6976c16d308c9824d0fb5a1a4584783b50ce875cfc0a70ec9baa',
        endHash: '000000000005bdeca5589bcc3cc96d7640cee0da12dfd8a3f9d1570badad3148',
      },
      {
        id: '[block 84k to 86k]',
        startHash: '00000000000105b3a92fd559761e51ab4df27094f49ff0f0125d2735f58e782a',
        endHash: '00000000000da1ba624fb54eae891d687270e5c29ead14856d5a8e9d4e152717',
      },
      {
        id: '[block 86k to 88k]',
        startHash: '000000000000173858848e25ee3f2ee30b26035eef117bb1e9506f6827a32c2f',
        endHash: '00000000000876b1f2b3e761e832af7bd3d82b6e0c8b0e186ac10efa07c20596',
      },
      {
        id: '[block 88k to 90k]',
        startHash: '00000000000b24ae2f45a87a60b9bd13f78262cf9156c921788a3498e1b44589',
        endHash: '00000000000abe864e35a620067c8635950f94e5f8959fcf83e6647bef76815e',
      },
      {
        id: '[block 90k to 92k]',
        startHash: '00000000000832a99fe95e6b950e4bce3812bd3bf307110d5d24502b65a808a8',
        endHash: '00000000000525ae9de4495de6cd2f1ad6d211fe73cee0967cc43377cbd3c6c6',
      },
      {
        id: '[block 92k to 94k]',
        startHash: '00000000000ae63418974eba958f4164eba3007da94702a0eabada8cdfa4160c',
        endHash: '0000000000024be28f0b69f81d00d793577d91a38625056949c706cf619eb973',
      },
      {
        id: '[block 94k to 96k]',
        startHash: '0000000000051b02b1b81155a33e9321f174a34935a5f6969ba0516fa66c11b7',
        endHash: '0000000000012d6f236578a9c23d5421045b412145bfb725c03399efd1743694',
      },
      {
        id: '[block 96k to 98k]',
        startHash: '00000000000172ac7a0075a030069f111db14bd29578c68f92ea91793c2c3dde',
        endHash: '0000000000018a3761ab09608fe6b09c346fa0d44e78754792164fc82bed7361',
      },
      {
        id: '[block 98k to 100k]',
        startHash: '00000000000410dfcfc0896b12dd4753eb37ae9ac19f5645a2f6c74e1469c4f4',
        endHash: '00000000000903d05a6cdbc50665da787035af22a56bec9448a4207ad3eefd00',
      },
      {
        id: '[block 100k to 102k]',
        startHash: '0000000000015dabbb321d2ddaa3ee0c5e453068b8a7092ea29c382a41c3215c',
        endHash: '000000000002366cd6638d6d8eed7008de4c88ae5e014a5544017407e93cb048',
      },
      {
        id: '[block 102k to 104k]',
        startHash: '000000000002b2371fe85d5d6813e06ca26e54f6c2b5e8c83a93fd1d83d28746',
        endHash: '0000000000025b4c78baa0ae71084bd03588f3e07b4dd0ec6768d05155890854',
      },
      {
        id: '[block 104k to 106k]',
        startHash: '0000000000067a6f369ed2cea770ecf897da7de0da81d071759350dc16927c47',
        endHash: '000000000009b92899fd456bfe48dd8c94d91f574f31c1e20bdfbfbf17cbdb0e',
      },
      {
        id: '[block 106k to 108k]',
        startHash: '00000000000031729f16b9b7a0b87e450826a1fdded98998dc9c98f125b477cc',
        endHash: '00000000000639eed3199e07f36fed4df76fd880b978b4850404c5a900a0e118',
      },
      {
        id: '[block 108k to 110k]',
        startHash: '000000000003a27de852c818497e075eaed0fd906562ff1d3ad3286f2c94043c',
        endHash: '000000000006327ba0f5bfa67957199b1f7fc3fc262741eaefd55fdcfe7a5ba5',
      },
      {
        id: '[block 110k to 112k]',
        startHash: '000000000004ffc41e999621f527cccd67f2e21b711cb6a9ab6017c329a0b957',
        endHash: '000000000002c87890c7de64016a57c530dcf619b2db59b91da95a415c9c9147',
      },
      {
        id: '[block 112k to 114k]',
        startHash: '0000000000071282a6d4a1918712de8fcca05c04df0446c87168e690f7ee40b6',
        endHash: '000000000008e31664dc15d00e878f1ee3bcda3a88305c1ffcecc74fccac6a7a',
      },
      {
        id: '[block 114k to 116k]',
        startHash: '00000000000721c26d2821b26742a92138f0ceda71f08e22203e071da27b16a8',
        endHash: '000000000006d7f6f2c8fbdb8c5cbbc0a7524e1a92b6b244edd69044799de74c',
      },
      {
        id: '[block 116k to 118k]',
        startHash: '000000000007dfa75b63d37d9959c6ca70b30d4192bf00486448e87c29afd859',
        endHash: '000000000005626acaf6af665851cff1cd2a78680a09dc88ae7c96f0fd788c6e',
      },
      {
        id: '[block 118k to 120k]',
        startHash: '0000000000057421020796d2c3254b85d37a9d13887e039c6ffe1c7ddefb5ec6',
        endHash: '000000000001c891d48b9352a8ec9412962165cfd05ed84e95a7a3e9f289f9cd',
      },
      {
        id: '[block 120k to 122k]',
        startHash: '000000000000e0f464586d8e481df64bd54fea088b2a1c9e20eba7e209d40a15',
        endHash: '0000000000066a0d75b6e23e99923181f550dc727e9e91326ed2759d372bee7c',
      },
      {
        id: '[block 122k to 124k]',
        startHash: '000000000002dacdfc42318f8ecbce823a9013a527ebc909069b48c11dfb846b',
        endHash: '000000000004d3ef2d08c51f089cc81b1a1c29ada9ee18e581c1856d8f094a80',
      },
      {
        id: '[block 124k to 126k]',
        startHash: '00000000000670580752f3b5b68fb78b84d0ca37ecc2a78d511a0a07c84e37c9',
        endHash: '000000000009b6be3ed6cb4ce742bfb369c9cdf6020fe16a00f850afa5c5a4fd',
      },
      {
        id: '[block 126k to 128k]',
        startHash: '0000000000081a3169e03c888b59b8b9f421be9ad7209420bdafe1d1d2750941',
        endHash: '0000000000085dccefad9461c5c259f70c4cb4668eac91626f479b7dfe9ce389',
      },
      {
        id: '[block 128k to 130k]',
        startHash: '00000000000b7649c6b62357c3fe6eb6673a874a234c6e572040957654905797',
        endHash: '0000000000040c6faa8d3b8e71c68e6609a5031e645b18f66cbcf7886c00a32c',
      },
      {
        id: '[block 130k to 132k]',
        startHash: '00000000000877f4940643232e26b99e267c1f492b1027ce8a655330bad2add2',
        endHash: '000000000006eeca2bbe5c4c18f9a2023a33d7d3c3c0d5078892ba81178560f0',
      },
      {
        id: '[block 132k to 134k]',
        startHash: '000000000006f14874784365fdff3399ee44243aeda3804431d16f8092cb96e9',
        endHash: '0000000000005f03e16f9a4ea30de501adf0f1d1c08f0abe7fb541ac4a2a5752',
      },
      {
        id: '[block 134k to 136k]',
        startHash: '00000000000235cfc8d2a2a2facc87342bd2d77a37e0116ed7a8105581984cc3',
        endHash: '0000000000016420f2e73d1f326964c87003d475d8d1f40eb6d0b717a27558e3',
      },
      {
        id: '[block 136k to 138k]',
        startHash: '00000000000588f711438c13d438ac9cf8791cd5c90e3e7e91eaadbb5cb12aeb',
        endHash: '0000000000048381ab234371d537cd5c19b17b2af09cbb0d6d9348e90fb93e6d',
      },
      {
        id: '[block 138k to 140k]',
        startHash: '0000000000007c1d8ec9d504460d494b155c5ef70a3d1ada95a3340c1e1518cc',
        endHash: '0000000000055efaff6ab2c15d1feed1dc2382b8e52c225ec1363e84f5226d8c',
      },
      {
        id: '[block 140k to 142k]',
        startHash: '000000000001f1e2c1f4e5a943bc903b90b5a0ae3c0071a84c06c5459f4d3e4c',
        endHash: '0000000000079364cd375068a73531d0fbd3680b51075385be510b73ff3fc050',
      },
      {
        id: '[block 142k to 144k]',
        startHash: '00000000000674aa7decba482dc5866b64eab43896d55adbd7732afeb15d2829',
        endHash: '00000000000002fcb30e7a5d688d8ef1336bc652a9889f7810fc23599066e16c',
      },
      {
        id: '[block 144k to 146k]',
        startHash: '000000000000a5b50f71e30fb06b42de330757efaab0173344fc7ebd2decf8b8',
        endHash: '00000000000241b9307c9d6b2f91732170c12ccee2c4b76524cab2c86e127519',
      },
    ]

    scanB.onTransactionHack.emit(`(start)`)

    await Promise.all(
      blocksToFetch.map(async (block) => {
        await this.scanTransactionFromBlockToBlock(
          block.id,
          Buffer.from(block.startHash, 'hex'),
          Buffer.from(block.endHash, 'hex'),
          accounts,
          scanB,
        )
      }),
    )

    scanB.onTransactionHack.emit(`(end)`)

    // update last block hash
    const endHash = Buffer.from(
      `00000000000241b9307c9d6b2f91732170c12ccee2c4b76524cab2c86e127519`,
      'hex',
    )
    for (const account of accounts) {
      await this.updateHeadHash(account, endHash)
    }

    scanB.onTransactionHack.emit(`(updated account head hash)`)

    await new Promise((r) => setTimeout(r, 2000))

    scanB.signalComplete()
    this.scanB = null
  }

  async getBalance(
    account: Account,
  ): Promise<{ unconfirmed: BigInt; confirmed: BigInt; headHash: string | null }> {
    return await this.db.database.transaction(async (tx) => {
      this.assertHasAccount(account)

      const headHash = await account.getHeadHash(tx)
      if (!headHash) {
        return {
          unconfirmed: BigInt(0),
          confirmed: BigInt(0),
          headHash: null,
        }
      }

      const header = await this.chain.getHeader(headHash)
      Assert.isNotNull(header, `Missing block header for hash '${headHash.toString('hex')}'`)

      const headSequence = header.sequence
      const unconfirmedSequenceStart =
        headSequence - this.config.get('minimumBlockConfirmations')

      const accountBalance = await account.getBalance(
        unconfirmedSequenceStart,
        headSequence,
        tx,
      )

      return {
        unconfirmed: accountBalance.unconfirmed,
        confirmed: accountBalance.confirmed,
        headHash,
      }
    })
  }

  private async getUnspentNotes(account: Account): Promise<
    ReadonlyArray<{
      hash: Buffer
      note: Note
      index: number | null
      confirmed: boolean
    }>
  > {
    const minimumBlockConfirmations = this.config.get('minimumBlockConfirmations')
    const notes = []
    const unspentNotes = account.getUnspentNotes()

    for await (const { hash, note, index, transactionHash } of unspentNotes) {
      let confirmed = false

      if (transactionHash) {
        const transaction = await account.getTransaction(transactionHash)
        Assert.isNotUndefined(
          transaction,
          `Transaction '${transactionHash.toString('hex')}' missing for account '${
            account.id
          }'`,
        )
        const { blockHash } = transaction

        if (blockHash) {
          const header = await this.chain.getHeader(blockHash)
          Assert.isNotNull(
            header,
            `getUnspentNotes: No header found for hash ${blockHash.toString('hex')}`,
          )
          const main = await this.chain.isHeadChain(header)
          if (main) {
            const confirmations = this.chain.head.sequence - header.sequence
            confirmed = confirmations >= minimumBlockConfirmations
          }
        }
      }

      notes.push({
        confirmed,
        hash,
        index,
        note,
      })
    }

    return notes
  }

  async pay(
    memPool: MemPool,
    sender: Account,
    receives: { publicAddress: string; amount: bigint; memo: string }[],
    transactionFee: bigint,
    defaultTransactionExpirationSequenceDelta: number,
    expirationSequence?: number | null,
  ): Promise<Transaction> {
    const heaviestHead = this.chain.head
    if (heaviestHead === null) {
      throw new ValidationError('You must have a genesis block to create a transaction')
    }

    expirationSequence =
      expirationSequence ?? heaviestHead.sequence + defaultTransactionExpirationSequenceDelta

    if (this.chain.verifier.isExpiredSequence(expirationSequence, this.chain.head.sequence)) {
      throw new ValidationError('Invalid expiration sequence for transaction')
    }

    const transaction = await this.createTransaction(
      sender,
      receives,
      transactionFee,
      expirationSequence,
    )

    await this.syncTransaction(transaction, { submittedSequence: heaviestHead.sequence })
    memPool.acceptTransaction(transaction)
    this.broadcastTransaction(transaction)
    this.onTransactionCreated.emit(transaction)

    return transaction
  }

  async createTransaction(
    sender: Account,
    receives: { publicAddress: string; amount: bigint; memo: string }[],
    transactionFee: bigint,
    expirationSequence: number,
  ): Promise<Transaction> {
    const unlock = await this.createTransactionMutex.lock()

    try {
      this.assertHasAccount(sender)

      // TODO: If we're spending from multiple accounts, we need to figure out a
      // way to split the transaction fee. - deekerno
      let amountNeeded =
        receives.reduce((acc, receive) => acc + receive.amount, BigInt(0)) + transactionFee

      const notesToSpend: Array<{ note: Note; witness: NoteWitness }> = []
      const unspentNotes = await this.getUnspentNotes(sender)

      for (const unspentNote of unspentNotes) {
        // Skip unconfirmed notes
        if (unspentNote.index === null || !unspentNote.confirmed) {
          continue
        }

        if (unspentNote.note.value() > BigInt(0)) {
          // Double-check that the nullifier for the note isn't in the tree already
          // This would indicate a bug in the account transaction stores
          const nullifier = Buffer.from(
            unspentNote.note.nullifier(sender.spendingKey, BigInt(unspentNote.index)),
          )

          if (await this.chain.nullifiers.contains(nullifier)) {
            this.logger.debug(
              `Note was marked unspent, but nullifier found in tree: ${nullifier.toString(
                'hex',
              )}`,
            )

            // Update our map so this doesn't happen again
            const noteMapValue = await sender.getDecryptedNote(unspentNote.hash)
            if (noteMapValue) {
              this.logger.debug(`Unspent note has index ${String(noteMapValue.index)}`)
              await sender.updateDecryptedNote(unspentNote.hash, {
                ...noteMapValue,
                spent: true,
              })
            }

            // Move on to the next note
            continue
          }

          // Try creating a witness from the note
          const witness = await this.chain.notes.witness(unspentNote.index)

          if (witness === null) {
            this.logger.debug(
              `Could not create a witness for note with index ${unspentNote.index}`,
            )
            continue
          }

          // Otherwise, push the note into the list of notes to spend
          this.logger.debug(
            `Accounts: spending note ${unspentNote.index} ${unspentNote.hash.toString(
              'hex',
            )} ${unspentNote.note.value()}`,
          )
          notesToSpend.push({ note: unspentNote.note, witness: witness })
          amountNeeded -= unspentNote.note.value()
        }

        if (amountNeeded <= 0) {
          break
        }
      }

      if (amountNeeded > 0) {
        throw new Error('Insufficient funds')
      }

      return this.workerPool.createTransaction(
        sender.spendingKey,
        transactionFee,
        notesToSpend.map((n) => ({
          note: n.note,
          treeSize: n.witness.treeSize(),
          authPath: n.witness.authenticationPath,
          rootHash: n.witness.rootHash,
        })),
        receives,
        expirationSequence,
      )
    } finally {
      unlock()
    }
  }

  broadcastTransaction(transaction: Transaction): void {
    this.onBroadcastTransaction.emit(transaction)
  }

  async rebroadcastTransactions(): Promise<void> {
    if (!this.isStarted) {
      return
    }

    if (!this.chain.synced) {
      return
    }

    if (this.chainProcessor.hash === null) {
      return
    }

    const head = await this.chain.getHeader(this.chainProcessor.hash)

    if (head === null) {
      return
    }

    for (const account of this.accounts.values()) {
      for await (const transactionInfo of account.getTransactions()) {
        const { transaction, blockHash, submittedSequence } = transactionInfo
        const transactionHash = transaction.hash()

        // Skip transactions that are already added to a block
        if (blockHash) {
          continue
        }

        // TODO: Submitted sequence is only set from transactions generated by this node and we don't rebroadcast
        // transactions to us, or from us and generated from another node, but we should do this later. It
        // will require us to set submittedSequence in syncTransaction to the current head if it's null
        if (!submittedSequence) {
          continue
        }

        // TODO: This algorithm suffers a deanonymization attack where you can
        // watch to see what transactions node continuously send out, then you can
        // know those transactions are theres. This should be randomized and made
        // less, predictable later to help prevent that attack.
        if (head.sequence - submittedSequence < this.rebroadcastAfter) {
          continue
        }

        let isValid = true
        await this.db.database.transaction(async (tx) => {
          const verify = await this.chain.verifier.verifyTransactionAdd(transaction)

          // We still update this even if it's not valid to prevent constantly
          // reprocessing valid transaction every block. Give them a few blocks to
          // try to become valid.
          await account.updateTransaction(
            transactionHash,
            {
              ...transactionInfo,
              submittedSequence: head.sequence,
            },
            tx,
          )

          if (!verify.valid) {
            isValid = false
            this.logger.debug(
              `Ignoring invalid transaction during rebroadcast ${transactionHash.toString(
                'hex',
              )}, reason ${String(verify.reason)} seq: ${head.sequence}`,
            )
          }
        })

        if (!isValid) {
          continue
        }
        this.broadcastTransaction(transaction)
      }
    }
  }

  async expireTransactions(): Promise<void> {
    if (!this.chain.synced) {
      return
    }

    if (this.chainProcessor.hash === null) {
      return
    }

    const head = await this.chain.getHeader(this.chainProcessor.hash)

    if (head === null) {
      return
    }

    for (const account of this.accounts.values()) {
      for await (const { transaction, blockHash } of account.getTransactions()) {
        // Skip transactions that are already added to a block
        if (blockHash) {
          continue
        }

        const isExpired = this.chain.verifier.isExpiredSequence(
          transaction.expirationSequence(),
          head.sequence,
        )

        if (isExpired) {
          await this.deleteTransaction(transaction)
        }
      }
    }
  }

  async createAccount(name: string, setDefault = false): Promise<Account> {
    if (this.getAccountByName(name)) {
      throw new Error(`Account already exists with the name ${name}`)
    }

    const key = generateKey()

    const account = new Account({
      id: uuid(),
      name,
      incomingViewKey: key.incoming_view_key,
      outgoingViewKey: key.outgoing_view_key,
      publicAddress: key.public_address,
      spendingKey: key.spending_key,
      accountsDb: this.db,
    })

    await this.db.database.transaction(async (tx) => {
      await this.db.setAccount(account, tx)
      await this.updateHeadHash(account, this.chainProcessor.hash, tx)
    })

    this.accounts.set(account.id, account)

    if (setDefault) {
      await this.setDefaultAccount(account.name)
    }

    return account
  }

  async skipRescan(account: Account): Promise<void> {
    await this.updateHeadHash(account, this.chainProcessor.hash)
  }

  async importAccount(toImport: Omit<AccountValue, 'rescan' | 'id'>): Promise<Account> {
    validateAccount(toImport)

    if (toImport.name && this.getAccountByName(toImport.name)) {
      throw new Error(`Account already exists with the name ${toImport.name}`)
    }

    if (this.listAccounts().find((a) => toImport.spendingKey === a.spendingKey)) {
      throw new Error(`Account already exists with provided spending key`)
    }

    const account = new Account({
      ...toImport,
      id: uuid(),
      accountsDb: this.db,
    })

    await this.db.database.transaction(async (tx) => {
      this.accounts.set(account.id, account)
      await this.db.setAccount(account, tx)
      await this.updateHeadHash(account, null, tx)
    })

    this.onAccountImported.emit(account)

    return account
  }

  listAccounts(): Account[] {
    return Array.from(this.accounts.values())
  }

  accountExists(name: string): boolean {
    return this.getAccountByName(name) !== null
  }

  async removeAccount(name: string): Promise<void> {
    const account = this.getAccountByName(name)
    if (!account) {
      return
    }

    await this.db.database.transaction(async (tx) => {
      if (account.id === this.defaultAccount) {
        await this.db.setDefaultAccount(null, tx)
        this.defaultAccount = null
      }

      await this.db.removeAccount(account.id, tx)
      await this.db.removeHeadHash(account, tx)
      this.accounts.delete(account.id)
    })

    this.onAccountRemoved.emit(account)
  }

  get hasDefaultAccount(): boolean {
    return !!this.defaultAccount
  }

  /** Set or clear the default account */
  async setDefaultAccount(name: string | null, tx?: IDatabaseTransaction): Promise<void> {
    let next = null

    if (name) {
      next = this.getAccountByName(name)

      if (!next) {
        throw new Error(`No account found with name ${name}`)
      }

      if (this.defaultAccount === next.id) {
        return
      }
    }

    const nextId = next ? next.id : null
    await this.db.setDefaultAccount(nextId, tx)
    this.defaultAccount = nextId
  }

  getAccountByName(name: string): Account | null {
    for (const account of this.accounts.values()) {
      if (name === account.name) {
        return account
      }
    }
    return null
  }

  getAccount(id: string): Account | null {
    const account = this.accounts.get(id)

    if (account) {
      return account
    }

    return null
  }

  getDefaultAccount(): Account | null {
    if (!this.defaultAccount) {
      return null
    }

    return this.getAccount(this.defaultAccount)
  }

  async generateNewPublicAddress(account: Account): Promise<void> {
    this.assertHasAccount(account)
    const key = generateNewPublicAddress(account.spendingKey)
    account.publicAddress = key.public_address
    await this.db.setAccount(account)
  }

  async getEarliestHeadHash(): Promise<Buffer | null> {
    let earliestHeader = null
    for (const account of this.accounts.values()) {
      const headHash = this.headHashes.get(account.id)

      if (!headHash) {
        return null
      }

      const header = await this.chain.getHeader(headHash)

      if (!header) {
        // If no header is returned, the hash is likely invalid and we should remove it
        this.logger.warn(
          `${account.displayName} has an invalid head hash ${headHash.toString(
            'hex',
          )}. This account needs to be rescanned.`,
        )
        await this.db.saveHeadHash(account, null)
        continue
      }

      if (!earliestHeader || earliestHeader.sequence > header.sequence) {
        earliestHeader = header
      }
    }

    return earliestHeader ? earliestHeader.hash : null
  }

  async getLatestHeadHash(): Promise<Buffer | null> {
    let latestHeader = null

    for (const headHash of this.headHashes.values()) {
      if (!headHash) {
        continue
      }

      const header = await this.chain.getHeader(headHash)
      Assert.isNotNull(
        header,
        `getLatestHeadHash: No header found for ${headHash.toString('hex')}`,
      )

      if (!latestHeader || latestHeader.sequence < header.sequence) {
        latestHeader = header
      }
    }

    return latestHeader ? latestHeader.hash : null
  }

  isAccountUpToDate(account: Account): boolean {
    const headHash = this.headHashes.get(account.id)
    Assert.isNotUndefined(
      headHash,
      `isAccountUpToDate: No head hash found for account ${account.displayName}`,
    )

    const chainHeadHash = this.chainProcessor.hash ? this.chainProcessor.hash : null

    return BufferUtils.equalsNullable(headHash, chainHeadHash)
  }

  protected assertHasAccount(account: Account): void {
    if (!this.accountExists(account.name)) {
      throw new Error(`No account found with name ${account.name}`)
    }
  }

  protected assertNotHasAccount(account: Account): void {
    if (this.accountExists(account.name)) {
      throw new Error(`No account found with name ${account.name}`)
    }
  }
}

export class ScanState {
  onTransaction = new Event<[sequence: number, endSequence: number]>()
  onTransactionHack = new Event<[note: string]>()

  sequence = -1
  endSequence = -1

  readonly startedAt: number
  readonly abortController: AbortController
  private runningPromise: Promise<void>
  private runningResolve: PromiseResolve<void>

  constructor() {
    const [promise, resolve] = PromiseUtils.split<void>()
    this.runningPromise = promise
    this.runningResolve = resolve

    this.abortController = new AbortController()
    this.startedAt = Date.now()
  }

  get isAborted(): boolean {
    return this.abortController.signal.aborted
  }

  signal(sequence: number): void {
    this.sequence = sequence
    this.onTransaction.emit(sequence, this.endSequence)
  }

  signalComplete(): void {
    this.runningResolve()
  }

  async abort(): Promise<void> {
    this.abortController.abort()
    return this.wait()
  }

  wait(): Promise<void> {
    return this.runningPromise
  }
}
