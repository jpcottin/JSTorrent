import { describe, it, expect } from 'vitest'
import { SlidingAverage } from '../../src/utils/sliding-average'

describe('SlidingAverage', () => {
  it('should initialize with zero samples', () => {
    const avg = new SlidingAverage(20)
    expect(avg.numSamples).toBe(0)
    expect(avg.mean).toBe(0)
    expect(avg.deviation).toBe(0)
  })

  it('should set mean to first sample', () => {
    const avg = new SlidingAverage(20)
    avg.add(100)
    expect(avg.mean).toBe(100)
    expect(avg.numSamples).toBe(1)
  })

  it('should converge toward repeated samples', () => {
    const avg = new SlidingAverage(20)
    // Add 50 samples of 100ms
    for (let i = 0; i < 50; i++) {
      avg.add(100)
    }
    expect(avg.mean).toBeCloseTo(100, 0)
    // Deviation should be near 0 for constant input
    expect(avg.deviation).toBeLessThan(5)
  })

  it('should track deviation for varying samples', () => {
    const avg = new SlidingAverage(20)
    // Alternate between 50 and 150 — mean should be ~100, deviation ~50
    for (let i = 0; i < 100; i++) {
      avg.add(i % 2 === 0 ? 50 : 150)
    }
    // EMA may oscillate slightly around 100 due to asymmetry
    expect(Math.abs(avg.mean - 100)).toBeLessThan(5)
    expect(avg.deviation).toBeGreaterThan(20)
  })

  it('should react to changes over time', () => {
    const avg = new SlidingAverage(10) // Shorter window for faster reaction
    // Establish a baseline of 100
    for (let i = 0; i < 20; i++) {
      avg.add(100)
    }
    expect(avg.mean).toBeCloseTo(100, 0)

    // Switch to 200 — mean should move toward 200
    for (let i = 0; i < 20; i++) {
      avg.add(200)
    }
    expect(avg.mean).toBeGreaterThan(150)
  })

  it('should use configurable window size', () => {
    // Small window: reacts quickly
    const fast = new SlidingAverage(2)
    fast.add(100)
    fast.add(200)
    fast.add(200)
    // With window=2, mean should be close to 200
    expect(fast.mean).toBeGreaterThan(150)

    // Large window: reacts slowly
    const slow = new SlidingAverage(100)
    slow.add(100)
    slow.add(200)
    slow.add(200)
    // With window=100, mean should still be close to 100
    expect(slow.mean).toBeLessThan(110)
  })
})
