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
        '',
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
