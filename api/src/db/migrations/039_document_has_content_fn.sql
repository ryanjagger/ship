-- SQL helper for the team-grid "is this plan/retro filled in?" check
-- (audit/api-reponse-time/peer-review.md #9).
--
-- Mirrors the JS `hasContent` helper in api/src/utils/document-content.ts:
-- concatenate all `text` nodes from a TipTap JSON document, strip the three
-- canonical template headings, and return true if any non-whitespace text
-- remains. Marked IMMUTABLE so PostgreSQL can inline / cache it during plans.
--
-- Replaces the pattern of selecting full TipTap `content` for every plan and
-- retro just to call a JS boolean. With this function, the heatmap endpoints
-- can SELECT just the boolean and skip transferring megabytes of JSONB to the
-- API process.

CREATE OR REPLACE FUNCTION document_has_content(content jsonb)
RETURNS boolean
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT length(
    btrim(
      regexp_replace(
        coalesce(
          (
            SELECT string_agg(t.value #>> '{}', '')
            FROM jsonb_path_query(content, 'lax $.**.text') AS t(value)
          ),
          ''
        ),
        'What I plan to accomplish this week|What I delivered this week|Unplanned work',
        '', 'g'
      )
    )
  ) > 0;
$$;
