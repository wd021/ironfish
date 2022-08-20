/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import * as yup from 'yup'
import { ApiNamespace, router } from '../router'

export type RescanAccountHackRequest = { accountNames: Array<string> }
export type RescanAccountHackResponse = { note: string }

export const RescanAccountHackRequestSchema: yup.ObjectSchema<RescanAccountHackRequest> = yup
  .object({
    accountNames: yup.array(yup.string().defined()).defined(),
  })
  .defined()

export const RescanAccountHackResponseSchema: yup.ObjectSchema<RescanAccountHackResponse> = yup
  .object({
    note: yup.string().defined(),
  })
  .defined()

router.register<typeof RescanAccountHackRequestSchema, RescanAccountHackResponse>(
  `${ApiNamespace.account}/rescanAccountHack`,
  RescanAccountHackRequestSchema,
  async (request, node): Promise<void> => {
    void node.accounts.scanTransactionsHack(request.data.accountNames)
    const scan = node.accounts.scanB

    request.stream({
      note: `starting - ${request.data.accountNames.toString().split(',').join(', ')} / ${
        scan?.startedAt || ''
      }`,
    })

    const onTransaction = (note: string) => {
      request.stream({
        note: note,
      })
    }

    if (scan) {
      scan.onTransactionHack.on(onTransaction)
      request.onClose.on(() => {
        scan?.onTransactionHack.off(onTransaction)
      })

      await scan.wait()
    }

    request.end()
  },
)
