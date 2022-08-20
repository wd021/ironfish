/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { IronfishCommand } from '../../command'
import { RemoteFlags } from '../../flags'

export class RescanCommand extends IronfishCommand {
  static description = `Rescan the blockchain for transaction`

  static flags = {
    ...RemoteFlags,
  }

  async start(): Promise<void> {
    const client = await this.sdk.connectRpc(true)
    const response = client.rescanAccountHackStream({
      accountNames: [
        'e75d0350191a2439e2e552562ee93c32233c5f69f8f7c9d9243ff72374700be25c99bae01b9c2570b09b61',
        'bee1ec28ec9e86efdd3bd654d8d64b1f902115eae49176671c57262167034d0c0c462bcd05ec8bdfe7978a',
        '3667e9f2d94c646146f4715dbb1c2ed9d96c564cfea04ad7a484d2f9064e6c926aab86f83b6633f98685a0',
      ],
    })

    try {
      for await (const { note } of response.contentStream()) {
        this.log(`progress: ${note}`)
      }
    } catch (error) {
      this.log(`error: ${JSON.stringify(error)}`)
    }

    this.log(`Scanning Complete`)
  }
}
