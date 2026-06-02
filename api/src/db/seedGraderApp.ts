#!/usr/bin/env tsx
/**
 * Idempotent seed for the Plugforge grader (PRD §5.9, gate item 10).
 *
 * Creates (or refreshes):
 *   - a Ship login the grader uses to reach the consent screen,
 *   - a demo workspace with a few sample documents to read,
 *   - a READ-ONLY OAuth app (`documents:read`) with a FIXED client_id +
 *     client_secret so they can be documented in the README.
 *
 * The fixed secret living in the README is deliberate — this is a throwaway
 * demo client for grading, not a real credential. Run with:
 *   pnpm --filter @ship/api db:seed:grader
 */
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Pool } from 'pg';
import bcrypt from 'bcryptjs';
import { loadProductionSecrets } from '../config/ssm.js';

config({ path: join(dirname(fileURLToPath(import.meta.url)), '../../.env.local') });

// Documented, fixed grader credentials. Override via env for a private deploy.
const GRADER_EMAIL = process.env.GRADER_EMAIL ?? 'grader@ship.local';
const GRADER_PASSWORD = process.env.GRADER_PASSWORD ?? 'GraderDemo123!';
const GRADER_WORKSPACE = process.env.GRADER_WORKSPACE ?? 'Grader Demo Workspace';
const GRADER_CLIENT_ID = process.env.GRADER_CLIENT_ID ?? 'client_grader_readonly';
const GRADER_CLIENT_SECRET = process.env.GRADER_CLIENT_SECRET ?? 'secret_grader_readonly_demo';
const GRADER_REDIRECT_URIS = (
  process.env.GRADER_REDIRECT_URIS ??
  'http://localhost:5173/callback,https://oauth.pstmn.io/v1/callback'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

async function main(): Promise<void> {
  await loadProductionSecrets();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL is not set');
    process.exit(1);
  }
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });

  try {
    // Workspace (get-or-create; workspaces has no unique-on-name constraint).
    const existingWs = await pool.query<{ id: string }>(
      `SELECT id FROM workspaces WHERE name = $1 ORDER BY created_at ASC LIMIT 1`,
      [GRADER_WORKSPACE]
    );
    let workspaceId = existingWs.rows[0]?.id;
    if (!workspaceId) {
      const created = await pool.query<{ id: string }>(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [
        GRADER_WORKSPACE,
      ]);
      workspaceId = created.rows[0]!.id;
    }

    // Grader user (login → consent screen)
    const passwordHash = await bcrypt.hash(GRADER_PASSWORD, 12);
    const userRes = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash)
       VALUES ($1, 'Plugforge Grader', $2)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
       RETURNING id`,
      [GRADER_EMAIL, passwordHash]
    );
    const userId = userRes.rows[0]!.id;

    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role)
       VALUES ($1, $2, 'admin')
       ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      [workspaceId, userId]
    );

    // Sample documents (only if the workspace has none yet)
    const docCount = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM documents WHERE workspace_id = $1 AND deleted_at IS NULL`,
      [workspaceId]
    );
    if (Number(docCount.rows[0]!.n) === 0) {
      const samples: Array<[string, string]> = [
        ['wiki', 'Getting Started'],
        ['wiki', 'API Concepts'],
        ['issue', 'Sample Issue: ship the SDK'],
      ];
      for (const [type, title] of samples) {
        await pool.query(
          `INSERT INTO documents (workspace_id, document_type, title, visibility, created_by)
           VALUES ($1, $2::document_type, $3, 'workspace', $4)`,
          [workspaceId, type, title, userId]
        );
      }
    }

    // Read-only OAuth app with the fixed, documented credentials.
    const secretHash = await bcrypt.hash(GRADER_CLIENT_SECRET, 12);
    await pool.query(
      `INSERT INTO oauth_apps (client_id, client_secret_hash, name, redirect_uris, owner_user_id, requested_scopes)
       VALUES ($1, $2, 'Plugforge Grader (read-only)', $3, $4, ARRAY['documents:read'])
       ON CONFLICT (client_id) DO UPDATE SET
         client_secret_hash = EXCLUDED.client_secret_hash,
         redirect_uris      = EXCLUDED.redirect_uris,
         requested_scopes   = EXCLUDED.requested_scopes,
         updated_at         = now()`,
      [GRADER_CLIENT_ID, secretHash, GRADER_REDIRECT_URIS, userId]
    );

    console.log('✅ Grader seed complete');
    console.log(`   workspace : ${GRADER_WORKSPACE} (${workspaceId})`);
    console.log(`   login     : ${GRADER_EMAIL} / ${GRADER_PASSWORD}`);
    console.log(`   client_id : ${GRADER_CLIENT_ID}`);
    console.log(`   secret    : ${GRADER_CLIENT_SECRET}`);
    console.log(`   scopes    : documents:read`);
    console.log(`   redirects : ${GRADER_REDIRECT_URIS.join(', ')}`);
  } catch (error) {
    console.error('Grader seed failed:', error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
