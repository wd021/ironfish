/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import * as yup from 'yup'
import { ApiNamespace, router } from '../router'
import { getAccount, getTransactionStatus } from './utils'

export type GetAccountTransactionsRequest = { account?: string }

export type GetAccountTransactionsResponse = {
  account: string
  transactions: {
    creator: boolean
    status: string
    hash: string
    isMinersFee: boolean
    fee: number
    notes: number
    spends: number
    expiration: number
  }[]
}

export const GetAccountTransactionsRequestSchema: yup.ObjectSchema<GetAccountTransactionsRequest> =
  yup
    .object({
      account: yup.string().strip(true),
    })
    .defined()

export const GetAccountTransactionsResponseSchema: yup.ObjectSchema<GetAccountTransactionsResponse> =
  yup
    .object({
      account: yup.string().defined(),
      transactions: yup
        .array(
          yup
            .object({
              creator: yup.boolean().defined(),
              status: yup.string().defined(),
              hash: yup.string().defined(),
              isMinersFee: yup.boolean().defined(),
              fee: yup.number().defined(),
              notes: yup.number().defined(),
              spends: yup.number().defined(),
              expiration: yup.number().defined(),
            })
            .defined(),
        )
        .defined(),
    })
    .defined()

router.register<typeof GetAccountTransactionsRequestSchema, GetAccountTransactionsResponse>(
  `${ApiNamespace.account}/getAccountTransactions`,
  GetAccountTransactionsRequestSchema,
  async (request, node): Promise<void> => {
    const account = getAccount(node, request.data.account)
    const transactions = account.getTransactions()
    const responseTransactions = []

    for (const { transaction, blockHash, sequence } of transactions) {
      let transactionCreator = false

      for (const spend of transaction.spends()) {
        if (account.getNoteHash(spend.nullifier)) {
          transactionCreator = true
          break
        }
      }

      const status = await getTransactionStatus(
        node,
        blockHash,
        sequence,
        transaction.expirationSequence(),
      )

      responseTransactions.push({
        creator: transactionCreator,
        status,
        hash: transaction.unsignedHash().toString('hex'),
        isMinersFee: transaction.isMinersFee(),
        fee: Number(transaction.fee()),
        notes: transaction.notesLength(),
        spends: transaction.spendsLength(),
        expiration: transaction.expirationSequence(),
      })
    }

    request.end({
      account: account.displayName,
      transactions: responseTransactions,
    })
  },
)
