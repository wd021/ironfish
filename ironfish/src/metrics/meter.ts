/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { SetIntervalToken } from '../utils'
import { EwmaAverage } from './ewmaAverage'

/**
 * A metric type useful for recording metered things like
 *  * blocks per second
 *  * bytes per second
 *
 * This metric will take a sample of how many units were
 * completd each tick cycle and record that in various
 * rolling averages.
 *
 * */
export class Meter {
  private _started = false
  private _rate1s: EwmaAverage
  private _rate5s: EwmaAverage
  private _rate1m: EwmaAverage
  private _rate5m: EwmaAverage
  private _average: EwmaAverage
  private _count = 0
  private _interval: SetIntervalToken | null = null
  private _intervalMs: number
  private _intervalLastMs: number | null = null

  private _halfLife = 1

  private readonly METER_TIME_INTERVALS_MS = {
    rate1s: 1000,
    rate5s: 5000,
    rate1m: 1 * 60 * 1000,
    rate5m: 5 * 60 * 1000,
    average: 100,
  }

  constructor() {
    this._intervalMs = 1000
    this._rate1s = new EwmaAverage(this._halfLife)
    this._rate5s = new EwmaAverage(this._halfLife)
    this._rate1m = new EwmaAverage(this._halfLife)
    this._rate5m = new EwmaAverage(this._halfLife)
    this._average = new EwmaAverage(this._halfLife)
  }

  get rate1s(): number {
    return this._rate1s.average
  }

  get rate5s(): number {
    return this._rate5s.average
  }

  get rate1m(): number {
    return this._rate1m.average
  }

  get rate5m(): number {
    return this._rate5m.average
  }

  get avg(): number {
    return this._average.average
  }

  add(count: number): void {
    if (!this._started) {
      return
    }
    this._count += count
    this._average.add(count, this.METER_TIME_INTERVALS_MS.average)
  }

  start(): void {
    if (this._started) {
      return
    }
    this._started = true
    this._interval = setInterval(() => this.update(), this._intervalMs)
  }

  stop(): void {
    if (!this._started) {
      return
    }
    this._started = false
    this._intervalLastMs = null
    this._count = 0

    if (this._interval) {
      clearInterval(this._interval)
    }
  }

  reset(): void {
    this._rate1s.reset()
    this._rate5s.reset()
    this._rate1m.reset()
    this._rate5m.reset()
    this._average.reset()
    this._count = 0
    this._intervalLastMs = null
  }

  private update(): void {
    const now = Date.now()

    if (this._intervalLastMs === null) {
      this._intervalLastMs = now
      return
    }

    const elapsedMs = now - this._intervalLastMs
    const rateSec = elapsedMs === 0 ? 0 : (this._count / elapsedMs) * 1000

    this._rate1s.add(rateSec, this.METER_TIME_INTERVALS_MS.rate1s / this._intervalMs)
    this._rate5s.add(rateSec, this.METER_TIME_INTERVALS_MS.rate5s / this._intervalMs)
    this._rate1m.add(rateSec, this.METER_TIME_INTERVALS_MS.rate1m / this._intervalMs)
    this._rate5m.add(rateSec, this.METER_TIME_INTERVALS_MS.rate5m / this._intervalMs)
    this._count = 0
    this._intervalLastMs = now
  }
}
