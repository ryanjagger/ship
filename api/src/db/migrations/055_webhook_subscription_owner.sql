-- Migration 055: record the user who owns each webhook subscription.
--
-- Webhook fan-out must respect document visibility. The public read path only
-- exposes a private document (visibility='private') to its creator
-- (visibility='workspace' OR created_by = <user>), but webhook delivery fans out
-- to every matching app/workspace subscription — leaking a private DTO to apps
-- whose token could not read it. We gate fan-out by the SAME rule, which needs
-- to know which user each subscription acts as (the user who authorized the app
-- when the subscription was created).
--
-- Existing rows get NULL owner: they still receive workspace-visible events, and
-- (correctly) stop receiving private-document events until recreated.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

ALTER TABLE webhook_subscriptions
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
