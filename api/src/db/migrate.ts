#!/usr/bin/env npx ts-node
/**
 * Database migration script
 * 1. Runs schema.sql for initial table setup
 * 2. Runs numbered migration files from migrations/ folder
 * 3. Tracks completed migrations in schema_migrations table
 */
import { config } from 'dotenv';
import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Pool } from 'pg';
import { loadProductionSecrets } from '../config/ssm.js';

// Load .env.local for local development
config({ path: join(dirname(fileURLToPath(import.meta.url)), '../../.env.local') });

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Postgres SQLSTATE codes for "this object already exists" collisions.
const DUPLICATE_OBJECT_CODES = new Set([
  '42P07', // duplicate_table
  '42710', // duplicate_object (type, trigger, constraint, ...)
  '42701', // duplicate_column
  '42P06', // duplicate_schema
  '42723', // duplicate_function
  '42P04', // duplicate_database
  '42712', // duplicate_alias
]);

function isAlreadyExistsError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  if (code && DUPLICATE_OBJECT_CODES.has(code)) return true;
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('already exists');
}

async function migrate() {
  await loadProductionSecrets();

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL environment variable is not set');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });

  try {
    console.log('Running database migrations...');

    // Step 1: Run schema.sql for initial setup.
    //
    // schema.sql is only fully idempotent for an empty database. On an existing
    // database some statements (e.g. the bare `CREATE TRIGGER
    // prevent_circular_parent_trigger`, which has no IF NOT EXISTS form) raise
    // "already exists". That is expected and harmless — the schema is already
    // there. Crucially this MUST be caught here, not by the outer catch:
    // otherwise the throw skips the entire numbered-migration loop below, so no
    // migration ever runs after the database's first deploy.
    const schemaPath = join(__dirname, 'schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');
    try {
      await pool.query(schema);
      console.log('✅ Schema applied');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('already exists')) {
        console.log('Schema already exists, continuing to migrations...');
      } else {
        throw err;
      }
    }

    // Step 2: Create migrations tracking table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT now()
      )
    `);

    // Step 3: Get list of already-applied migrations
    const appliedResult = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
    const appliedMigrations = new Set(appliedResult.rows.map(r => r.version));

    // Step 4: Find and run pending migrations
    const migrationsDir = join(__dirname, 'migrations');
    let migrationFiles: string[] = [];

    try {
      migrationFiles = readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql'))
        .sort(); // Ensures numeric order: 001_, 002_, etc.
    } catch {
      console.log('ℹ️  No migrations directory found');
    }

    let migrationsRun = 0;
    for (const file of migrationFiles) {
      const version = file.replace('.sql', '');

      if (appliedMigrations.has(version)) {
        continue; // Already applied
      }

      console.log(`  Running migration: ${file}`);
      const migrationPath = join(migrationsDir, file);
      const migrationSql = readFileSync(migrationPath, 'utf-8');

      // Run migration in a transaction
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(migrationSql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
        console.log(`  ✅ ${file} applied`);
        migrationsRun++;
      } catch (err) {
        await client.query('ROLLBACK');

        // schema.sql is this repo's source of truth for a fresh database and
        // already contains the cumulative effect of the historical migrations.
        // On a database provisioned from schema.sql, replaying an older
        // migration therefore collides with objects that already exist. Treat a
        // pure duplicate-object error as "already applied": record it and move
        // on, so the loop can still reach genuinely-new migrations. Any other
        // error is a real failure and propagates.
        if (isAlreadyExistsError(err)) {
          await pool.query(
            'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING',
            [version],
          );
          console.log(`  ↷ ${file} skipped (objects already exist; marked applied)`);
        } else {
          throw err;
        }
      } finally {
        client.release();
      }
    }

    if (migrationsRun === 0) {
      console.log('✅ All migrations already applied');
    } else {
      console.log(`✅ ${migrationsRun} migration(s) applied successfully`);
    }

  } catch (error) {
    // schema.sql "already exists" is handled above; anything reaching here is a
    // real failure (including a migration that errors with "already exists").
    console.error('Database migration failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
