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
        '6446517f513c182155c0bbd8de10c5f06f884926772e2fbc8b65e7d9803909fab8a07086f5b373b475c0be',
        '4a875a5d2e0dc67fe5bd2b713a274d869614914c0089749a4de98a265bd64bd6d56c0413e3ac2f33b15686',
        '40328a5f6f3d3500a475785f579f95629dd2ad7ae7afc2629ba3f09a08b6dc0584ba1baa94a39ccbf51e63',
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
