/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createRootLogger, Logger } from '../logger'
import { Telemetry } from '../telemetry/telemetry'
import { SetIntervalToken } from '../utils'
import { Gauge } from './gauge'
import { Meter } from './meter'

export class MetricsMonitor {
  private _started = false
  private _meters: Meter[] = []
  private readonly telemetry: Telemetry | null
  private readonly logger: Logger

  readonly p2p_InboundTraffic: Meter
  readonly p2p_InboundTraffic_WS: Meter
  readonly p2p_InboundTraffic_WebRTC: Meter

  readonly p2p_OutboundTraffic: Meter
  readonly p2p_OutboundTraffic_WS: Meter
  readonly p2p_OutboundTraffic_WebRTC: Meter

  readonly heapTotal: Gauge
  readonly heapUsed: Gauge
  readonly rss: Gauge
  private memoryInterval: SetIntervalToken | null
  private memoryTelemetryInterval: SetIntervalToken | null
  private readonly memoryRefreshPeriodMs = 1000
  private readonly memoryTelemetryPeriodMs = 15 * 1000

  constructor({ telemetry, logger }: { telemetry?: Telemetry; logger?: Logger }) {
    this.telemetry = telemetry ?? null
    this.logger = logger ?? createRootLogger()

    this.p2p_InboundTraffic = this.addMeter()
    this.p2p_InboundTraffic_WS = this.addMeter()
    this.p2p_InboundTraffic_WebRTC = this.addMeter()

    this.p2p_OutboundTraffic = this.addMeter()
    this.p2p_OutboundTraffic_WS = this.addMeter()
    this.p2p_OutboundTraffic_WebRTC = this.addMeter()

    this.heapTotal = new Gauge()
    this.heapUsed = new Gauge()
    this.rss = new Gauge()
    this.memoryInterval = null
    this.memoryTelemetryInterval = null
  }

  get started(): boolean {
    return this._started
  }

  start(): void {
    this._started = true
    this._meters.forEach((m) => m.start())

    this.memoryInterval = setInterval(() => this.refreshMemory(), this.memoryRefreshPeriodMs)
    if (this.telemetry) {
      this.memoryTelemetryInterval = setInterval(
        () => void this.submitMemoryTelemetry(),
        this.memoryTelemetryPeriodMs,
      )
    }
  }

  stop(): void {
    this._started = false
    this._meters.forEach((m) => m.stop())

    if (this.memoryInterval) {
      clearTimeout(this.memoryInterval)
    }

    if (this.memoryTelemetryInterval) {
      clearTimeout(this.memoryTelemetryInterval)
    }
  }

  addMeter(): Meter {
    const meter = new Meter()
    this._meters.push(meter)
    if (this._started) {
      meter.start()
    }
    return meter
  }

  private refreshMemory(): void {
    const memoryUsage = process.memoryUsage()
    this.heapTotal.value = memoryUsage.heapTotal
    this.heapUsed.value = memoryUsage.heapUsed
    this.rss.value = memoryUsage.rss
  }

  private async submitMemoryTelemetry(): Promise<void> {
    if (this.telemetry) {
      await this.telemetry.submit({
        measurement: 'node',
        name: 'memory',
        fields: [
          {
            name: 'heap_used',
            type: 'integer',
            value: this.heapUsed.value,
          },
          {
            name: 'heap_total',
            type: 'integer',
            value: this.heapTotal.value,
          },
        ],
      })
    }
  }
}
