import { describe, it, expect } from 'vitest'
import { compareVersions } from '../src/version.js'

describe('compareVersions', () => {
  it('returns 1 when a > b', () => {
    expect(compareVersions('0.1.21', '0.1.20')).toBe(1)
    expect(compareVersions('1.0.0', '0.1.21')).toBe(1)
    expect(compareVersions('0.2.0', '0.1.99')).toBe(1)
  })

  it('returns 0 when equal', () => {
    expect(compareVersions('0.1.21', '0.1.21')).toBe(0)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
  })

  it('returns -1 when a < b', () => {
    expect(compareVersions('0.1.20', '0.1.21')).toBe(-1)
    expect(compareVersions('0.1.21', '1.0.0')).toBe(-1)
  })

  it('handles different segment counts', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0', '1.0.1')).toBe(-1)
  })
})
