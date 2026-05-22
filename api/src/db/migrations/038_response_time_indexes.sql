-- Expression and partial indexes targeting the filter/sort patterns
-- documented in audit/api-reponse-time/peer-review.md (#5 and #6).
--
-- The existing idx_documents_properties GIN helps containment/`?` operators
-- but does NOT cover `properties->>'x' = 'y'` btree equality, ranges, or
-- ORDER BY on extracted text fields. The indexes below back the hottest
-- list/filter queries in api/src/routes/{issues,dashboard,team,standups,weeks}.ts.

-- --- Issues list filter+sort (api/src/routes/issues.ts:115) ----------------
CREATE INDEX IF NOT EXISTS idx_issues_state
  ON documents ((properties->>'state'))
  WHERE document_type = 'issue' AND archived_at IS NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_issues_priority
  ON documents ((properties->>'priority'))
  WHERE document_type = 'issue' AND archived_at IS NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_issues_assignee
  ON documents ((properties->>'assignee_id'))
  WHERE document_type = 'issue' AND archived_at IS NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_issues_source
  ON documents ((properties->>'source'))
  WHERE document_type = 'issue' AND archived_at IS NULL AND deleted_at IS NULL;

-- --- Weekly plan / retro lookup by person+week ----------------------------
-- (api/src/routes/dashboard.ts and api/src/routes/team.ts both filter by
--  person_id and week_number on these document types.)
CREATE INDEX IF NOT EXISTS idx_weekly_plan_person_week
  ON documents (
    (properties->>'person_id'),
    ((properties->>'week_number')::int)
  )
  WHERE document_type = 'weekly_plan' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_weekly_retro_person_week
  ON documents (
    (properties->>'person_id'),
    ((properties->>'week_number')::int)
  )
  WHERE document_type = 'weekly_retro' AND deleted_at IS NULL;

-- --- Standup lookup by author+date ----------------------------------------
-- (api/src/routes/dashboard.ts looks up the current user's standup for a date.)
CREATE INDEX IF NOT EXISTS idx_standups_author_date
  ON documents (
    (properties->>'author_id'),
    (properties->>'date')
  )
  WHERE document_type = 'standup' AND deleted_at IS NULL;

-- --- Sprint assignee_ids array membership ---------------------------------
-- (api/src/routes/dashboard.ts and team.ts probe assignee_ids inside sprint
--  properties; needs GIN to support the @> / ? operators on a JSONB array.)
CREATE INDEX IF NOT EXISTS idx_sprint_assignee_ids
  ON documents USING GIN ((properties->'assignee_ids'))
  WHERE document_type = 'sprint';

-- --- API token hash lookup ------------------------------------------------
-- (api/src/middleware/auth.ts validateApiToken filters by token_hash; there
--  is currently no index on this column, so each API-token request is a
--  sequential scan. This becomes a bottleneck as soon as the table grows
--  beyond a handful of rows. See peer-review.md #6.)
CREATE INDEX IF NOT EXISTS idx_api_tokens_token_hash
  ON api_tokens (token_hash);
