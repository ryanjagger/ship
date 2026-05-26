import { beforeAll, afterAll } from 'vitest'
import { pool } from '../db/client.js'

// Test setup for API integration tests
// This runs before all tests in each test file

beforeAll(async () => {
  // Ensure test environment
  process.env.NODE_ENV = 'test'

  // SAFETY GUARD: this setup TRUNCATEs every table, so it must NEVER run against
  // a dev/prod database. The suite targets a dedicated test DB via vitest.config
  // (DATABASE_URL → ship_test). If the live connection is not a test database
  // (name must contain "test"), refuse to truncate and fail loudly — a misconfig
  // previously wiped the shared ship_dev database.
  const { rows } = await pool.query<{ db: string }>('SELECT current_database() AS db')
  const dbName = rows[0]?.db ?? ''
  if (!/test/i.test(dbName)) {
    throw new Error(
      `Refusing to TRUNCATE: connected to "${dbName}", which is not a test database. ` +
      `API tests must run against a DB whose name contains "test" (e.g. ship_test). ` +
      `Check DATABASE_URL / vitest.config.ts test.env before running the suite.`
    )
  }

  // Clean up test data from previous runs to prevent duplicate key errors
  // Use TRUNCATE CASCADE which is faster and bypasses row-level triggers
  // (audit_logs has AU-9 compliance triggers preventing DELETE)
  await pool.query(`TRUNCATE TABLE
    workspace_invites, sessions, files, document_links, document_history,
    comments, document_associations, document_snapshots, sprint_iterations,
    issue_iterations, documents, audit_logs, workspace_memberships,
    users, workspaces
    CASCADE`)
})

afterAll(async () => {
  // Close pool only at the very end - vitest handles this via globalTeardown
})
