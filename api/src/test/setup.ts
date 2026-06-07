import { beforeAll, afterAll } from 'vitest'
import { pool } from '../db/client.js'

// Test setup for API integration tests
// This runs before all tests in each test file

/**
 * Whether a database name is a recognized TEST database, gating the destructive
 * TRUNCATE below. ANCHORED on a word boundary at the END (`_test` or `test`) — an
 * unanchored `/test/` substring would dangerously match dev/prod names like
 * 'latest', 'attestation', or 'dev_testbed' and TRUNCATE them. We accept exactly
 * 'ship_test', the bare 'test', and any `..._test`; we reject 'latest',
 * 'attestation', 'testbed', 'dev_testbed'.
 */
export function isTestDatabaseName(name: string): boolean {
  return name === 'ship_test' || /(^|_)test$/i.test(name)
}

beforeAll(async () => {
  // Ensure test environment
  process.env.NODE_ENV = 'test'

  // SAFETY GUARD: this setup TRUNCATEs every table, so it must NEVER run against
  // a dev/prod database. The suite targets a dedicated test DB via vitest.config
  // (DATABASE_URL → ship_test). If the live connection is not a recognized test
  // database, refuse to truncate and fail loudly — a misconfig previously wiped
  // the shared ship_dev database.
  const { rows } = await pool.query<{ db: string }>('SELECT current_database() AS db')
  const dbName = rows[0]?.db ?? ''
  if (!isTestDatabaseName(dbName)) {
    throw new Error(
      `Refusing to TRUNCATE: connected to "${dbName}", which is not a test database. ` +
      `API tests must run against a DB whose name ends in "_test" (e.g. ship_test). ` +
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

  // Re-seed the Fleet service user (migration 062) — an invariant row real
  // environments always have, but the TRUNCATE above wipes. DB-backed sweep
  // tests resolve it via getFleetServiceUserId(), which throws when missing.
  await pool.query(
    `INSERT INTO users (email, password_hash, name, is_super_admin)
     VALUES ('fleet@ship.system', NULL, 'Fleet', true)
     ON CONFLICT (email) DO NOTHING`
  )
})

afterAll(async () => {
  // Close pool only at the very end - vitest handles this via globalTeardown
})
