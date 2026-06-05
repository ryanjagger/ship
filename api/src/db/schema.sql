-- Ship Database Schema
-- Everything is a Document - Unified Model
-- Multi-Workspace Architecture

-- Extensions
CREATE EXTENSION IF NOT EXISTS pg_trgm;  -- trigram GIN for leading-wildcard title search (migration 038)

-- Workspaces
-- `settings` is a single JSONB blob for per-workspace config (migration 047);
-- added last to match the column order produced by the ALTER-based migration.
CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  sprint_start_date DATE NOT NULL DEFAULT CURRENT_DATE,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  settings JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Users and auth (global identity - users can belong to multiple workspaces)
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,  -- NULL if using PIV-only auth
  name TEXT NOT NULL,
  is_super_admin BOOLEAN DEFAULT FALSE,
  last_workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
  x509_subject_dn TEXT,           -- PIV certificate X.509 Subject DN
  piv_first_login_at TIMESTAMPTZ, -- When user first logged in via PIV
  last_auth_provider VARCHAR(50), -- 'fpki_validator', 'caia', null (legacy)
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Case-insensitive email uniqueness (prevents duplicate users with different casing)
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique ON users (LOWER(email));

-- Workspace memberships (users can be in multiple workspaces with different roles)
-- AUTHORIZATION ONLY: This table controls access. Person documents (content layer) are separate.
-- Person docs link to users via properties.user_id, NOT via this table.
CREATE TABLE IF NOT EXISTS workspace_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(workspace_id, user_id)
);

-- Workspace invites (email invite flow)
CREATE TABLE IF NOT EXISTS workspace_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  token TEXT UNIQUE,  -- NULL for PIV invites (certificate proves identity)
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  invited_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  x509_subject_dn TEXT,  -- X.509 Subject DN for PIV invites
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Audit logs (compliance-grade logging)
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,  -- NULL for global actions
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,  -- NULL for failed login attempts
  impersonating_user_id UUID REFERENCES users(id) ON DELETE SET NULL,  -- If super-admin is impersonating
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id UUID,
  details JSONB,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Sessions with 15-minute inactivity timeout and 12-hour absolute timeout
-- Session ID is TEXT (hex string from crypto.randomBytes) not UUID for enhanced security
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  last_activity TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  -- Session binding data for audit and security
  user_agent TEXT,
  ip_address TEXT
);

-- OAuth state (survives server restarts during auth flow)
CREATE TABLE IF NOT EXISTS oauth_state (
  state_id TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- Document types enum
DO $$ BEGIN
  CREATE TYPE document_type AS ENUM ('wiki', 'issue', 'program', 'project', 'sprint', 'person', 'weekly_plan', 'weekly_retro', 'standup', 'weekly_review', 'conversation', 'insight');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Core document table (unified model - EVERYTHING IS A DOCUMENT)
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_type document_type NOT NULL DEFAULT 'wiki',
  title TEXT NOT NULL DEFAULT 'Untitled',

  -- TipTap JSON content stored as JSONB (shared by ALL document types)
  content JSONB DEFAULT '{"type":"doc","content":[{"type":"paragraph"}]}',

  -- Yjs binary state for collaboration (shared by ALL document types)
  yjs_state BYTEA,

  -- Hierarchy (cascade delete: deleting parent deletes all children)
  parent_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  position INTEGER DEFAULT 0,

  -- Associations: program, project, and sprint relationships are stored in document_associations table
  -- Legacy columns (project_id, sprint_id, program_id) were removed by migrations 027 and 029.
  -- Use document_associations table for all relationship queries.

  -- Type-specific properties stored as JSONB
  -- Issue properties: state, priority, assignee_id, source, rejection_reason
  -- Program/Project properties: color
  -- Sprint properties: start_date, end_date, sprint_status, plan
  -- Person properties: user_id (links to users.id), email, capacity_hours, skills
  properties JSONB DEFAULT '{}',

  -- Keep these as columns for indexing/relationships/sequences
  ticket_number INTEGER,  -- Auto-increment per workspace, needed for display_id
  archived_at TIMESTAMPTZ,  -- For filtering archived items
  deleted_at TIMESTAMPTZ,   -- For trash/soft delete (30 day retention)

  -- Status timestamps (for issues)
  started_at TIMESTAMPTZ,    -- When issue status first changed to in_progress
  completed_at TIMESTAMPTZ,  -- When issue status first changed to done
  cancelled_at TIMESTAMPTZ,  -- When issue status changed to cancelled
  reopened_at TIMESTAMPTZ,   -- When issue was reopened after being done/cancelled

  -- Document conversion tracking
  converted_to_id UUID REFERENCES documents(id) ON DELETE SET NULL,   -- Points to new doc (on archived original)
  converted_from_id UUID REFERENCES documents(id) ON DELETE SET NULL, -- Points to original doc (on new doc)
  converted_at TIMESTAMPTZ,
  converted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  original_type VARCHAR(50),    -- Original document_type when first created
  conversion_count INTEGER DEFAULT 0,  -- Number of times converted

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,

  -- Document visibility (private = creator only, workspace = all members)
  visibility TEXT NOT NULL DEFAULT 'workspace' CHECK (visibility IN ('private', 'workspace')),

  -- Prevent self-referencing parent
  CONSTRAINT documents_no_self_parent CHECK (id != parent_id)
);

-- Function and trigger to prevent circular parent references
CREATE OR REPLACE FUNCTION prevent_circular_parent()
RETURNS TRIGGER AS $$
DECLARE
  current_parent UUID;
  depth INT := 0;
  max_depth INT := 100;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.parent_id IS NOT DISTINCT FROM NEW.parent_id THEN
    RETURN NEW;
  END IF;
  current_parent := NEW.parent_id;
  WHILE current_parent IS NOT NULL AND depth < max_depth LOOP
    IF current_parent = NEW.id THEN
      RAISE EXCEPTION 'Circular reference detected: document % cannot be a descendant of itself', NEW.id;
    END IF;
    SELECT parent_id INTO current_parent FROM documents WHERE id = current_parent;
    depth := depth + 1;
  END LOOP;
  IF depth >= max_depth THEN
    RAISE EXCEPTION 'Maximum nesting depth (%) exceeded while checking for circular reference', max_depth;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS prevent_circular_parent_trigger ON documents;
CREATE TRIGGER prevent_circular_parent_trigger
BEFORE INSERT OR UPDATE OF parent_id ON documents
FOR EACH ROW
EXECUTE FUNCTION prevent_circular_parent();

-- Relationship type enum for document associations
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'relationship_type') THEN
    CREATE TYPE relationship_type AS ENUM ('parent', 'project', 'sprint', 'program', 'discusses');
  END IF;
END
$$;

-- Document associations junction table (replaces direct relationship columns)
CREATE TABLE IF NOT EXISTS document_associations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  related_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  relationship_type relationship_type NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB DEFAULT '{}',

  -- Prevent duplicate associations of the same type
  CONSTRAINT unique_association UNIQUE (document_id, related_id, relationship_type),

  -- Prevent self-references
  CONSTRAINT no_self_reference CHECK (document_id != related_id)
);

-- Document history (audit trail for all document field changes)
CREATE TABLE IF NOT EXISTS document_history (
  id SERIAL PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  changed_by UUID REFERENCES users(id),
  automated_by TEXT,  -- Identifies automated change source (e.g., "claude")
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Document snapshots (preserves state before type conversions for undo)
CREATE TABLE IF NOT EXISTS document_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,

  -- Snapshot of document state at time of conversion
  document_type VARCHAR(50) NOT NULL,
  title TEXT NOT NULL,
  properties JSONB,
  ticket_number INTEGER,  -- Preserved for issues

  -- Metadata
  snapshot_reason VARCHAR(50) NOT NULL DEFAULT 'conversion',  -- 'conversion', 'manual'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL
);

-- API tokens for CLI/external tool authentication
CREATE TABLE IF NOT EXISTS api_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,         -- User-provided name (e.g., "Claude Code")
  token_hash TEXT NOT NULL,   -- SHA-256 hash (never store plain token)
  token_prefix TEXT NOT NULL, -- First 8 chars for identification
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,     -- NULL = never expires
  revoked_at TIMESTAMPTZ,     -- NULL = active, timestamp = revoked
  created_at TIMESTAMPTZ DEFAULT now(),

  UNIQUE(user_id, workspace_id, name)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Plugforge: OAuth 2.0 Authorization Server (Ship as provider)
-- Mirrors migrations 048–050. Defined here too so fresh setups and the E2E
-- testcontainer (which seeds from schema.sql, not the migration SQL) get them.
-- All CREATE TABLE IF NOT EXISTS, so the migration re-runs are no-ops.
-- ─────────────────────────────────────────────────────────────────────────────

-- Registered OAuth client applications. Confidential client secrets are
-- bcrypt-hashed (verified once, at token exchange). Public PKCE clients do not
-- have a secret.
CREATE TABLE IF NOT EXISTS oauth_apps (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id          TEXT NOT NULL UNIQUE,
  client_secret_hash TEXT,
  name               TEXT NOT NULL,
  redirect_uris      TEXT[] NOT NULL DEFAULT '{}',
  owner_user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  requested_scopes   TEXT[] NOT NULL DEFAULT '{}',
  client_type        TEXT NOT NULL DEFAULT 'confidential'
    CHECK (client_type IN ('public', 'confidential')),
  -- Opt-in to the Device Authorization Grant (RFC 8628). OFF by default: a
  -- public device flow must never borrow a confidential client's identity.
  allow_device_flow  BOOLEAN NOT NULL DEFAULT false,
  -- Platform-managed first-party client (e.g. the `ship` CLI). System clients are
  -- provisioned by migration and cannot be deleted or rotated from the admin UI.
  is_system          BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT oauth_apps_confidential_secret_check
    CHECK (client_type = 'public' OR client_secret_hash IS NOT NULL)
);

-- Short-lived PKCE authorization codes (SHA-256-hashed, single-use).
CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash             TEXT NOT NULL UNIQUE,
  app_id                UUID NOT NULL REFERENCES oauth_apps(id) ON DELETE CASCADE,
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  redirect_uri          TEXT NOT NULL,
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  scopes                TEXT[] NOT NULL DEFAULT '{}',
  expires_at            TIMESTAMPTZ NOT NULL,
  consumed_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Opaque OAuth access tokens (SHA-256-hashed; validated per request).
CREATE TABLE IF NOT EXISTS access_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    TEXT NOT NULL UNIQUE,
  token_prefix  TEXT NOT NULL,
  app_id        UUID NOT NULL REFERENCES oauth_apps(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scopes        TEXT[] NOT NULL DEFAULT '{}',
  expires_at    TIMESTAMPTZ NOT NULL,
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rotating OAuth refresh tokens (SHA-256-hashed; opt-in via offline_access).
CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash            TEXT NOT NULL UNIQUE,
  token_prefix          TEXT NOT NULL,
  family_id             UUID NOT NULL,
  app_id                UUID NOT NULL REFERENCES oauth_apps(id) ON DELETE CASCADE,
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scopes                TEXT[] NOT NULL DEFAULT '{}',
  expires_at            TIMESTAMPTZ NOT NULL,
  used_at               TIMESTAMPTZ,
  revoked_at            TIMESTAMPTZ,
  replaced_by_token_id  UUID REFERENCES oauth_refresh_tokens(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_family
  ON oauth_refresh_tokens (family_id);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_active
  ON oauth_refresh_tokens (app_id, user_id, workspace_id)
  WHERE revoked_at IS NULL;

-- OAuth 2.0 Device Authorization Grant (RFC 8628) — backs `ship login`.
-- device_code is SHA-256-hashed at rest; user_code is the short human code.
CREATE TABLE IF NOT EXISTS oauth_device_codes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_code_hash TEXT NOT NULL UNIQUE,
  user_code        TEXT NOT NULL UNIQUE,
  app_id           UUID NOT NULL REFERENCES oauth_apps(id) ON DELETE CASCADE,
  scopes           TEXT[] NOT NULL DEFAULT '{}',
  status           TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | denied
  user_id          UUID REFERENCES users(id) ON DELETE CASCADE,
  workspace_id     UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  interval_seconds INTEGER NOT NULL DEFAULT 5,
  last_polled_at   TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ NOT NULL,
  approved_at      TIMESTAMPTZ,
  consumed_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sprint iterations (tracking work progress per sprint)
CREATE TABLE IF NOT EXISTS sprint_iterations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sprint_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  story_id TEXT,
  story_title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'in_progress')),
  what_attempted TEXT,
  blockers_encountered TEXT,
  author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Issue iterations (tracking work progress per issue)
CREATE TABLE IF NOT EXISTS issue_iterations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'in_progress')),
  what_attempted TEXT,
  blockers_encountered TEXT,
  author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- File uploads (images, attachments)
CREATE TABLE IF NOT EXISTS files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  uploaded_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  s3_key TEXT NOT NULL,        -- S3 object key (or local path for dev)
  cdn_url TEXT,                -- CloudFront URL after processing
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'uploaded', 'failed')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Document links (for backlinks feature)
CREATE TABLE IF NOT EXISTS document_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  target_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(source_id, target_id)
);

-- Comments (inline document comments with threading)
CREATE TABLE IF NOT EXISTS comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  comment_id UUID NOT NULL,  -- Thread identifier (matches TipTap mark commentId)
  parent_id UUID REFERENCES comments(id) ON DELETE CASCADE,  -- NULL for root, set for replies
  author_id UUID REFERENCES users(id) ON DELETE SET NULL,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  resolved_at TIMESTAMPTZ,  -- NULL when unresolved
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Session indexes
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace_id ON sessions(workspace_id);

-- OAuth state indexes
CREATE INDEX IF NOT EXISTS idx_oauth_state_expires_at ON oauth_state(expires_at);

-- User indexes
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_last_workspace_id ON users(last_workspace_id);
CREATE INDEX IF NOT EXISTS idx_users_x509_subject_dn ON users(x509_subject_dn) WHERE x509_subject_dn IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_last_auth_provider ON users(last_auth_provider) WHERE last_auth_provider IS NOT NULL;

-- Document indexes
CREATE INDEX IF NOT EXISTS idx_documents_workspace_id ON documents(workspace_id);
CREATE INDEX IF NOT EXISTS idx_documents_parent_id ON documents(parent_id);
CREATE INDEX IF NOT EXISTS idx_documents_document_type ON documents(document_type);
CREATE INDEX IF NOT EXISTS idx_documents_properties ON documents USING GIN (properties);
CREATE INDEX IF NOT EXISTS idx_documents_person_user_id ON documents ((properties->>'user_id')) WHERE document_type = 'person';

-- Document visibility indexes
CREATE INDEX IF NOT EXISTS idx_documents_visibility ON documents(visibility);
-- Note: idx_documents_visibility_created_by was dropped by migration 043 in
-- favor of the more targeted idx_documents_created_by (declared below).
-- Don't re-add the compound here — `db:migrate` runs schema.sql before
-- checking schema_migrations, so any CREATE INDEX here on an existing DB
-- would be re-applied while migration 043 (already-applied) is skipped.
CREATE INDEX IF NOT EXISTS idx_documents_created_by ON documents(created_by) WHERE deleted_at IS NULL;

-- Document archive/delete indexes
CREATE INDEX IF NOT EXISTS idx_documents_archived_at ON documents(archived_at) WHERE archived_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_deleted_at ON documents(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_active ON documents(workspace_id, document_type) WHERE archived_at IS NULL AND deleted_at IS NULL;

-- Document conversion indexes
CREATE INDEX IF NOT EXISTS idx_documents_converted_to ON documents(converted_to_id) WHERE converted_to_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_converted_from ON documents(converted_from_id) WHERE converted_from_id IS NOT NULL;

-- Document associations indexes
CREATE INDEX IF NOT EXISTS idx_document_associations_document_id ON document_associations(document_id);
CREATE INDEX IF NOT EXISTS idx_document_associations_related_id ON document_associations(related_id);
CREATE INDEX IF NOT EXISTS idx_document_associations_type ON document_associations(relationship_type);
CREATE INDEX IF NOT EXISTS idx_document_associations_related_type ON document_associations(related_id, relationship_type);
CREATE INDEX IF NOT EXISTS idx_document_associations_document_type ON document_associations(document_id, relationship_type);

-- Document history indexes
CREATE INDEX IF NOT EXISTS idx_document_history_document_created ON document_history(document_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_document_history_changed_by ON document_history(changed_by, created_at DESC);

-- Document snapshots indexes
CREATE INDEX IF NOT EXISTS idx_document_snapshots_document_id ON document_snapshots(document_id);
CREATE INDEX IF NOT EXISTS idx_document_snapshots_created_at ON document_snapshots(document_id, created_at DESC);

-- Workspace membership indexes
CREATE INDEX IF NOT EXISTS idx_workspace_memberships_workspace_id ON workspace_memberships(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_memberships_user_id ON workspace_memberships(user_id);

-- Workspace invite indexes
CREATE INDEX IF NOT EXISTS idx_workspace_invites_workspace_id ON workspace_invites(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_invites_email ON workspace_invites(email);
CREATE INDEX IF NOT EXISTS idx_workspace_invites_expires_at ON workspace_invites(expires_at);
CREATE INDEX IF NOT EXISTS idx_workspace_invites_x509_subject_dn ON workspace_invites(x509_subject_dn) WHERE x509_subject_dn IS NOT NULL AND used_at IS NULL;

-- Audit log indexes (compliance queries)
CREATE INDEX IF NOT EXISTS idx_audit_logs_workspace_created ON audit_logs(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_created ON audit_logs(actor_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);

-- API token indexes
CREATE INDEX IF NOT EXISTS idx_api_tokens_user_id ON api_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_api_tokens_workspace_id ON api_tokens(workspace_id);
CREATE INDEX IF NOT EXISTS idx_api_tokens_token_prefix ON api_tokens(token_prefix);

-- Sprint iterations indexes
CREATE INDEX IF NOT EXISTS idx_sprint_iterations_sprint_id ON sprint_iterations(sprint_id);
CREATE INDEX IF NOT EXISTS idx_sprint_iterations_workspace_id ON sprint_iterations(workspace_id);
CREATE INDEX IF NOT EXISTS idx_sprint_iterations_status ON sprint_iterations(status);
CREATE INDEX IF NOT EXISTS idx_sprint_iterations_story_id ON sprint_iterations(story_id);
CREATE INDEX IF NOT EXISTS idx_sprint_iterations_created_at ON sprint_iterations(created_at DESC);

-- Issue iterations indexes
CREATE INDEX IF NOT EXISTS idx_issue_iterations_issue_id ON issue_iterations(issue_id);
CREATE INDEX IF NOT EXISTS idx_issue_iterations_workspace_id ON issue_iterations(workspace_id);
CREATE INDEX IF NOT EXISTS idx_issue_iterations_status ON issue_iterations(status);
CREATE INDEX IF NOT EXISTS idx_issue_iterations_created_at ON issue_iterations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_issue_iterations_issue_workspace ON issue_iterations(issue_id, workspace_id);

-- File indexes
CREATE INDEX IF NOT EXISTS idx_files_workspace ON files(workspace_id);
CREATE INDEX IF NOT EXISTS idx_files_status ON files(status);

-- Document links indexes
CREATE INDEX IF NOT EXISTS idx_document_links_target ON document_links(target_id);
CREATE INDEX IF NOT EXISTS idx_document_links_source ON document_links(source_id);

-- Comments indexes
CREATE INDEX IF NOT EXISTS idx_comments_document_id ON comments(document_id);
CREATE INDEX IF NOT EXISTS idx_comments_comment_id ON comments(comment_id);
CREATE INDEX IF NOT EXISTS idx_comments_parent_id ON comments(parent_id);

-- Drop the legacy separate tables if they exist (greenfield cleanup)
DROP TABLE IF EXISTS sprints CASCADE;
DROP TABLE IF EXISTS projects CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Schema sync: hot-path indexes + FleetGraph insight invariants + Plugforge
-- webhooks & public-API tables. Mirrors migrations 038–058. Defined here (not
-- only in the migration SQL) so fresh setups and the E2E testcontainer — which
-- seed from schema.sql, not the migration files — get the full current schema.
-- All IF NOT EXISTS, so migration re-runs stay no-ops.
-- ─────────────────────────────────────────────────────────────────────────────

-- Hot query-path indexes (migrations 038–044). Partial + expression indexes on
-- the dominant documents.properties->> filters and the api-token auth lookup.
CREATE INDEX IF NOT EXISTS idx_documents_title_trgm
  ON documents USING GIN (title gin_trgm_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_documents_issue_assignee
  ON documents ((properties->>'assignee_id'))
  WHERE document_type = 'issue' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_documents_owner_id
  ON documents (workspace_id, document_type, (properties->>'owner_id'))
  WHERE deleted_at IS NULL AND archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_documents_standup_author_date
  ON documents ((properties->>'author_id'), (properties->>'date'))
  WHERE document_type = 'standup' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_documents_sprint_number
  ON documents (workspace_id, ((properties->>'sprint_number')::int))
  WHERE document_type = 'sprint' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_documents_issue_ticket
  ON documents (workspace_id, ticket_number DESC)
  WHERE document_type = 'issue';

CREATE INDEX IF NOT EXISTS idx_documents_weekly_plan_lookup
  ON documents (
    workspace_id,
    (properties->>'person_id'),
    (((properties->>'week_number')::int))
  )
  WHERE document_type = 'weekly_plan'
    AND archived_at IS NULL
    AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_documents_weekly_retro_lookup
  ON documents (
    workspace_id,
    (properties->>'person_id'),
    (((properties->>'week_number')::int))
  )
  WHERE document_type = 'weekly_retro'
    AND archived_at IS NULL
    AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_documents_active_type_position
  ON documents (workspace_id, document_type, position ASC, created_at DESC)
  WHERE archived_at IS NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_api_tokens_hash
  ON api_tokens (token_hash)
  WHERE revoked_at IS NULL;

-- FleetGraph insight invariants (migration 046): one OPEN insight per
-- (workspace, subject, kind), plus a shape CHECK on insight rows. The CHECK is
-- NOT VALID (matches the migration) — it enforces shape on new writes only.
CREATE UNIQUE INDEX IF NOT EXISTS insights_open_per_subject_kind
  ON documents (
    workspace_id,
    (properties->'fleetgraph_insight'->>'subject_id'),
    (properties->'fleetgraph_insight'->>'kind')
  )
  WHERE document_type = 'insight'
    AND properties->'fleetgraph_insight'->>'state' = 'open'
    AND archived_at IS NULL
    AND deleted_at IS NULL;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'documents_insight_properties_shape'
  ) THEN
    ALTER TABLE documents ADD CONSTRAINT documents_insight_properties_shape CHECK (
      document_type <> 'insight'
      OR (
        properties->'fleetgraph_insight'->>'subject_id' IS NOT NULL
        AND properties->'fleetgraph_insight'->>'kind' IS NOT NULL
        AND properties->'fleetgraph_insight'->>'state' IN
          ('open', 'resolved', 'snoozed', 'dismissed')
      )
    ) NOT VALID;
  END IF;
END $$;

-- ── Plugforge: Webhooks (migrations 054–055) ─────────────────────────────────
-- `created_by` (migration 055) is added last to match the ALTER-produced
-- column order.
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id             UUID NOT NULL REFERENCES oauth_apps(id) ON DELETE CASCADE,
  workspace_id       UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  url                TEXT NOT NULL,
  events             TEXT[] NOT NULL,
  encrypted_secret   TEXT NOT NULL,          -- AES-256-GCM: base64(iv|tag|ciphertext)
  secret_fingerprint TEXT NOT NULL,          -- 'sha256:...' — safe to display
  active             BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by         UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_ws_active
  ON webhook_subscriptions (workspace_id, active);
CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_app
  ON webhook_subscriptions (app_id);

CREATE TABLE IF NOT EXISTS webhook_events (
  id              TEXT PRIMARY KEY,           -- 'evt_...'
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  type            TEXT NOT NULL,
  api_version     TEXT NOT NULL,
  payload         JSONB NOT NULL,             -- full envelope as signed/sent
  idempotency_key TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webhook_events_ws_created
  ON webhook_events (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id           UUID NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  event_id                  TEXT NOT NULL REFERENCES webhook_events(id) ON DELETE CASCADE,
  status                    TEXT NOT NULL DEFAULT 'pending',  -- pending|delivered|failed|dead_lettered|replayed
  attempt_count             INT NOT NULL DEFAULT 0,
  next_attempt_at           TIMESTAMPTZ,       -- NULL once terminal
  last_attempt_at           TIMESTAMPTZ,
  last_response_status      INT,
  last_response_body_excerpt TEXT,
  last_error                TEXT,
  delivered_at              TIMESTAMPTZ,
  dead_lettered_at          TIMESTAMPTZ,
  replay_of_delivery_id     UUID REFERENCES webhook_deliveries(id) ON DELETE SET NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- THE tick-driving index: only pending rows that are due. Partial keeps it tiny.
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due
  ON webhook_deliveries (next_attempt_at)
  WHERE status = 'pending';
-- One ORIGINAL delivery per (subscription, event); replays carry a non-null
-- replay_of_delivery_id and are exempt so a replay can reuse the same event.
CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_deliveries_sub_event_original
  ON webhook_deliveries (subscription_id, event_id)
  WHERE replay_of_delivery_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_subscription
  ON webhook_deliveries (subscription_id, created_at DESC);

CREATE TABLE IF NOT EXISTS webhook_delivery_attempts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id           UUID NOT NULL REFERENCES webhook_deliveries(id) ON DELETE CASCADE,
  subscription_id       UUID NOT NULL,
  event_id              TEXT NOT NULL,
  attempt_number        INT NOT NULL,
  response_status       INT,
  response_body_excerpt TEXT,
  duration_ms           INT,
  error                 TEXT,
  sent_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webhook_delivery_attempts_delivery
  ON webhook_delivery_attempts (delivery_id, attempt_number);

-- ── Plugforge: Public API rate limiting (migration 057) ──────────────────────
CREATE TABLE IF NOT EXISTS public_api_rate_limit_buckets (
  bucket_key   TEXT PRIMARY KEY,
  bucket_limit INTEGER     NOT NULL,
  remaining    NUMERIC     NOT NULL,
  reset_at     TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE public_api_rate_limit_buckets IS
  'Continuous-refill token buckets for /api/v1 rate limiting, keyed app:<id> / token:<id> (migration 057).';

-- ── Plugforge: Public API audit trail (migration 058) ────────────────────────
CREATE TABLE IF NOT EXISTS public_api_audit_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  client_id     TEXT,                 -- denormalized: survives app deletion
  app_id        UUID,                 -- no FK: keep the row if the app is deleted
  token_id      UUID,
  user_id       UUID,
  workspace_id  UUID,
  method        TEXT        NOT NULL,
  route         TEXT        NOT NULL,  -- route TEMPLATE (e.g. /api/v1/issues/:id), not raw URL
  scope         TEXT,                 -- the scope actually matched for this call
  status        INTEGER     NOT NULL,
  latency_ms    INTEGER     NOT NULL,
  request_id    TEXT,
  ip_address    TEXT,
  user_agent    TEXT
);
CREATE INDEX IF NOT EXISTS idx_public_api_audit_ws_created   ON public_api_audit_logs (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_public_api_audit_app_created  ON public_api_audit_logs (app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_public_api_audit_user_created ON public_api_audit_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_public_api_audit_status_created ON public_api_audit_logs (status, created_at DESC);
COMMENT ON TABLE public_api_audit_logs IS
  'Customer-visible audit trail of authenticated /api/v1 requests (migration 058).';
