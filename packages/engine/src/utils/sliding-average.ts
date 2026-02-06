/**
 * Sliding window average with deviation tracking.
 * Matches libtorrent's sliding_average pattern used for RTT estimation.
 *
 * Uses exponential moving average (EMA) with a configurable window size.
 * Tracks both mean and mean absolute deviation for timeout calculation.
 *
 * libtorrent reference: aux_/sliding_average.hpp
 */
export class SlidingAverage {
  private _mean = 0
  private _deviation = 0
  private _numSamples = 0
  private readonly _invWindow: number

  /**
   * @param windowSize Number of samples for the averaging window.
   *   Larger windows smooth more but react slower to changes.
   */
  constructor(windowSize: number = 20) {
    this._invWindow = 1 / windowSize
  }

  /**
   * Add a new sample to the sliding average.
   * First sample initializes the mean directly.
   * Subsequent samples use exponential moving average.
   */
  add(sample: number): void {
    if (this._numSamples === 0) {
      this._mean = sample
      this._deviation = sample / 2 // Initial deviation estimate
    } else {
      const delta = sample - this._mean
      this._mean += delta * this._invWindow
      this._deviation += (Math.abs(delta) - this._deviation) * this._invWindow
    }
    this._numSamples++
  }

  /** Current smoothed mean. */
  get mean(): number {
    return this._mean
  }

  /** Current mean absolute deviation (approximation of standard deviation). */
  get deviation(): number {
    return this._deviation
  }

  /** Number of samples added so far. */
  get numSamples(): number {
    return this._numSamples
  }
}
