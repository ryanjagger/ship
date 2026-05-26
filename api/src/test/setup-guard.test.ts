import { describe, it, expect } from 'vitest'
import { isTestDatabaseName } from './setup.js'

// The TRUNCATE guard predicate must be ANCHORED: an unanchored `/test/` substring
// would match (and then wipe) dev/prod names containing "test" anywhere.
describe('isTestDatabaseName (TRUNCATE guard predicate)', () => {
  it('accepts recognized test databases', () => {
    expect(isTestDatabaseName('ship_test')).toBe(true)
    expect(isTestDatabaseName('test')).toBe(true)
    expect(isTestDatabaseName('api_test')).toBe(true)
    expect(isTestDatabaseName('ship_TEST')).toBe(true) // case-insensitive
  })

  it('rejects names that merely CONTAIN "test" (the old substring bug)', () => {
    expect(isTestDatabaseName('latest')).toBe(false)
    expect(isTestDatabaseName('attestation')).toBe(false)
    expect(isTestDatabaseName('testbed')).toBe(false)
    expect(isTestDatabaseName('dev_testbed')).toBe(false)
    expect(isTestDatabaseName('ship_dev')).toBe(false)
    expect(isTestDatabaseName('')).toBe(false)
  })
})
