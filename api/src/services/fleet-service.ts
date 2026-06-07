/**
 * Fleet analysis service.
 *
 * Gathers project signals through the public API (`/api/v1` via the Fleet
 * client, issue #95 — visibility as the acting user, no admin bypass) and
 * decides whether the plan is a good, testable hypothesis: does it name
 * what will change, for whom, by how much (AI-judged), and by when (the
 * project's Target Date)? It also produces a retro recommendation. The model is
 * NEVER allowed to set plan_validated; Fleet only advises (R7a).
 *
 * U4 builds the fresh result objects. U5 adds input-hash caching on
 * properties.fleet (getReview) — the cache WRITE stays internal (a v1 PATCH
 * would bump updated_at and fire project.updated webhooks for a cache refresh).
 */

import { createHash } from 'crypto';
import { pool } from '../db/client.js';
import { extractText } from '../utils/document-content.js';
import { ShipApiError } from '@ryanjagger/ship-sdk';
import { withFleetClient } from './fleetgraph/api-client.js';
import type {
  FleetPlanReview,
  FleetRetroRecommendation,
  FleetReviewResponse,
} from '@ship/shared';
import { hasText } from './fleet-checks.js';
import { isFleetAiAvailable, checkFleetReviewRateLimit } from './fleet-ai.js';
import { runPlanReview, runRetroRecommendation } from './fleetgraph/index.js';

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

export interface FleetContext {
  workspaceId: string;
  userId: string;
  isAdmin: boolean;
}

/** A cached AI sub-result on properties.fleet, keyed by its input hash. */
export interface FleetCacheEntry<T> {
  result: T;
  hash: string;
  computed_at: string;
}
export interface FleetCacheBlob {
  plan_review?: FleetCacheEntry<FleetPlanReview>;
  retro_recommendation?: FleetCacheEntry<FleetRetroRecommendation>;
}

export interface FleetSignals {
  projectId: string;
  title: string;
  plan: string | null;
  successCriteria: string[];
  monetaryImpactExpected: string | null;
  monetaryImpactActual: string | null;
  planValidated: boolean | null;
  /** ISO target date (properties.target_date), or null. Satisfies "by when". */
  targetDate: string | null;
  /** Plain text of the project/retro narrative (documents.content). */
  retroText: string;
  issues: {
    done: string[];
    cancelled: string[];
    active: string[];
  };
  weeksCount: number;
  /** Existing properties.fleet cache, if any (read alongside the signals). */
  existingCache: FleetCacheBlob | null;
}

interface ProjectRow {
  id: string;
  title: string;
  content: unknown;
  properties: {
    plan?: string | null;
    success_criteria?: string[] | null;
    monetary_impact_expected?: string | null;
    monetary_impact_actual?: string | null;
    plan_validated?: boolean | null;
    target_date?: string | null;
    fleet?: FleetCacheBlob | null;
  } | null;
}

/**
 * Returns the project's Fleet signals, or null when the project is not visible
 * to the requester. Reads travel /api/v1 as the acting user. Issues are
 * fetched at ORDINARY-MEMBER privilege (`visibility: 'workspace'` — never
 * widened, no created_by personalization) so the cached result is safe to
 * serve to any caller who can see the project, and the cache hashes
 * (planReviewHash / retroHash over plan/criteria/issues/impacts/retroText)
 * stay viewer-independent and unchanged by the transport.
 */
export async function gatherSignals(
  projectId: string,
  ctx: FleetContext
): Promise<FleetSignals | null> {
  return withFleetClient(ctx, async (client) => {
    // The broad document GET carries title, properties (including the
    // properties.fleet cache blob), AND content in one call; the typed project
    // DTO deliberately omits content. 404 → not visible → null.
    let doc;
    try {
      doc = await client.documents.get(projectId);
    } catch (err) {
      if (err instanceof ShipApiError && err.status === 404) return null;
      throw err;
    }
    if (doc.document_type !== 'project') return null;

    const props = (doc.properties ?? {}) as ProjectRow['properties'] & Record<string, unknown>;

    // Viewer-INDEPENDENT input for the shared per-project cache: only
    // workspace-visible issues. Same created_at ASC order as the v1 list.
    const done: string[] = [];
    const cancelled: string[] = [];
    const active: string[] = [];
    for await (const issue of client.issues.iterate({ belongs_to: projectId, belongs_to_type: 'project', visibility: 'workspace', limit: 100 })) {
      if (issue.state === 'done') done.push(issue.title);
      else if (issue.state === 'cancelled') cancelled.push(issue.title);
      else active.push(issue.title);
    }

    let weeksCount = 0;
    for await (const _sprint of client.sprints.iterate({ belongs_to: projectId, belongs_to_type: 'project', visibility: 'workspace', limit: 100 })) {
      weeksCount += 1;
    }

    const successCriteria = Array.isArray(props?.success_criteria)
      ? props.success_criteria.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
      : [];

    return {
      projectId: doc.id,
      title: doc.title,
      plan: props?.plan ?? null,
      successCriteria,
      monetaryImpactExpected: props?.monetary_impact_expected ?? null,
      monetaryImpactActual: props?.monetary_impact_actual ?? null,
      planValidated: props?.plan_validated ?? null,
      targetDate: props?.target_date ?? null,
      retroText: extractText(doc.content).trim(),
      issues: { done, cancelled, active },
      weeksCount,
      existingCache: (props?.fleet as FleetCacheBlob | null | undefined) ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Plan review — "is this a good, testable hypothesis?"
// ---------------------------------------------------------------------------
//
// NOTE: both AI compute paths now run through the FleetGraph graph and never
// from a direct `evaluateStructured` call here. Plan-review → `runPlanReview`
// (R13); retro recommendation → `runRetroRecommendation` (retro mode). The
// canonical schema/prompt/user-content for each live in their leaf config
// modules: `fleetgraph/plan-review-config.ts` and `fleetgraph/retro-config.ts`.
// `gatherSignals` here remains the source of the cache hashes (planReviewHash /
// retroHash); the graph re-fetches its own snapshot via the U5 read layer.

/**
 * The unavailable plan-review: no provider, AI error, or per-user rate budget
 * exhausted. No deterministic pieces (R18) — the feature requires a provider.
 */
function unavailablePlanReview(signals: FleetSignals): FleetPlanReview {
  return {
    status: hasText(signals.plan) ? 'needs_work' : 'no_plan',
    pieces: [],
    suggested_rewrite: null,
    ai_available: false,
  };
}

// ---------------------------------------------------------------------------
// Retro recommendation
// ---------------------------------------------------------------------------

/**
 * The unavailable retro recommendation: no provider, AI error, no plan, or
 * oversized input. No deterministic baseline (R18) — requires a provider.
 */
function unavailableRetroRecommendation(): FleetRetroRecommendation {
  return {
    recommendation: 'insufficient_evidence',
    explanation: 'Fleet recommendation requires a configured AI provider.',
    evidence_found: [],
    evidence_missing: [],
    suggested_conclusion: null,
    diagnosis: null,
    recommended_next_action: null,
    proposed_action: null,
    ai_available: false,
  };
}

// Retro recommendation compute is the FleetGraph `retro` mode
// (`runRetroRecommendation`). getReview gates it on plan-present + provider +
// rate budget (mirroring the plan-review path) and falls back to
// `unavailableRetroRecommendation()` on no-plan / no-provider / degraded.

// ---------------------------------------------------------------------------
// U5 — input-hash caching on properties.fleet
// ---------------------------------------------------------------------------

/** sha256 of a stable JSON serialization of the inputs (mirrors ai-analysis.ts). */
export function computeHash(parts: unknown): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

// Plan-review cache key: the inputs that affect the hypothesis check (plan text
// and the Target Date that satisfies "by when").
function planReviewHash(s: FleetSignals): string {
  return computeHash({ plan: s.plan, targetDate: s.targetDate });
}
// Retro-recommendation cache key: plan + criteria + execution evidence.
function retroHash(s: FleetSignals): string {
  return computeHash({
    plan: s.plan,
    successCriteria: s.successCriteria,
    issues: s.issues,
    impactExpected: s.monetaryImpactExpected,
    impactActual: s.monetaryImpactActual,
    retroText: s.retroText,
  });
}

export interface GetReviewOptions {
  force?: boolean;
}

/**
 * Lazy-on-miss review with per-sub-result caching on properties.fleet.
 *
 * Deterministic checks recompute every call (free). Each AI sub-result is
 * served from cache when its input hash is unchanged; on a miss (or `force`) it
 * is recomputed and — when AI actually contributed — persisted via a key-scoped
 * jsonb_set so a concurrent retro save's sibling keys are never clobbered.
 *
 * Returns null when the project is not visible to the requester.
 */
export async function getReview(
  projectId: string,
  ctx: FleetContext,
  opts: GetReviewOptions = {}
): Promise<FleetReviewResponse | null> {
  const signals = await gatherSignals(projectId, ctx);
  if (!signals) return null;

  const cache = signals.existingCache ?? {};
  const force = opts.force === true;

  const pHash = planReviewHash(signals);
  const rHash = retroHash(signals);
  const planMiss = force || !cache.plan_review || cache.plan_review.hash !== pHash;
  const retroMiss = force || !cache.retro_recommendation || cache.retro_recommendation.hash !== rHash;

  // Bound model spend on cache-miss GETs: a model call only happens on a miss.
  // `force` arrives via the already-rate-limited POST refresh route, so it is
  // exempt; otherwise an imminent model call consumes the per-user review budget
  // and degrades to deterministic-only when the user is over it. A cache hit
  // never consumes the budget.
  const wouldCallAi = isFleetAiAvailable() && (planMiss || retroMiss);
  const allowAi = force || !wouldCallAi || checkFleetReviewRateLimit(ctx.userId);

  // ----- plan review -----
  let planReview: FleetPlanReview;
  let planEntry: FleetCacheEntry<FleetPlanReview> | undefined = cache.plan_review;
  let planComputed = false;

  if (!hasText(signals.plan)) {
    // No plan → always 'no_plan'. Checked BEFORE the cache so a stale cached
    // review (e.g. computed when the project briefly had a plan, or before this
    // guard existed) is never served, and the model is never called on an empty
    // plan. Drop any stale AI entry so a retro persist won't rewrite it.
    planReview = unavailablePlanReview(signals); // status 'no_plan'
    planEntry = undefined;
  } else if (!planMiss && cache.plan_review) {
    planReview = { ...cache.plan_review.result, computed_at: cache.plan_review.computed_at };
  } else {
    // R13: the plan-review compute path is the graph (runPlanReview), not a
    // direct evaluateStructured call. diagnosis/recommendedNextAction from the
    // graph are NOT part of FleetReviewResponse — dropped to keep the card
    // contract identical (AE5).
    if (allowAi && isFleetAiAvailable()) {
      try {
        const graphResult = await runPlanReview({ entityId: projectId, entityType: 'project', ctx });
        planReview = graphResult.planReview;
      } catch (err) {
        console.warn('[fleet-service] graph plan-review failed:', err instanceof Error ? err.message : err);
        planReview = unavailablePlanReview(signals);
      }
    } else {
      // No provider, or per-user rate budget exhausted: unavailable — NO
      // deterministic pieces (R18).
      planReview = unavailablePlanReview(signals);
    }
    if (planReview.ai_available) {
      const computed_at = new Date().toISOString();
      planReview = { ...planReview, computed_at };
      planEntry = { result: planReview, hash: pHash, computed_at };
      planComputed = true;
    } else if (force) {
      planEntry = undefined; // forced refresh degraded → clear stale AI entry
    }
  }

  // ----- retro recommendation -----
  let retroRec: FleetRetroRecommendation;
  let retroEntry: FleetCacheEntry<FleetRetroRecommendation> | undefined = cache.retro_recommendation;
  let retroComputed = false;

  if (!retroMiss && cache.retro_recommendation) {
    retroRec = { ...cache.retro_recommendation.result, computed_at: cache.retro_recommendation.computed_at };
  } else {
    // Retro compute is the graph's `retro` mode. Gate it like plan-review:
    // requires a plan, a provider, and (on a non-forced miss) the per-user rate
    // budget. No plan / no provider / over budget → unavailable (R18), and a
    // graph throw degrades to unavailable too.
    if (hasText(signals.plan) && allowAi && isFleetAiAvailable()) {
      try {
        retroRec = await runRetroRecommendation({ entityId: projectId, entityType: 'project', ctx });
      } catch (err) {
        console.warn('[fleet-service] graph retro recommendation failed:', err instanceof Error ? err.message : err);
        retroRec = unavailableRetroRecommendation();
      }
    } else {
      retroRec = unavailableRetroRecommendation();
    }
    if (retroRec.ai_available) {
      const computed_at = new Date().toISOString();
      retroRec = { ...retroRec, computed_at };
      retroEntry = { result: retroRec, hash: rHash, computed_at };
      retroComputed = true;
    } else if (force) {
      retroEntry = undefined; // forced refresh degraded → clear stale AI entry
    }
  }

  // Persist when an AI sub-result was freshly computed, OR a forced refresh
  // cleared a now-stale AI entry. Key-scoped write (jsonb_set on '{fleet}')
  // leaves sibling keys intact and does NOT bump updated_at (cache writes are
  // not user edits).
  const clearedStale = force && ((!!cache.plan_review && !planEntry) || (!!cache.retro_recommendation && !retroEntry));
  if (planComputed || retroComputed || clearedStale) {
    const newBlob: FleetCacheBlob = {};
    if (planEntry) newBlob.plan_review = planEntry;
    if (retroEntry) newBlob.retro_recommendation = retroEntry;
    // Caching is best-effort: a write failure must not discard the freshly
    // computed review. Log and fall through to return the result.
    try {
      await pool.query(
        `UPDATE documents
           SET properties = jsonb_set(COALESCE(properties, '{}'::jsonb), '{fleet}', $1::jsonb, true)
         WHERE id = $2 AND workspace_id = $3 AND document_type = 'project'`,
        [JSON.stringify(newBlob), projectId, ctx.workspaceId]
      );
    } catch (err) {
      console.warn('[fleet-service] cache write failed:', err instanceof Error ? err.message : err);
    }
  }

  return {
    plan_review: planReview,
    retro_recommendation: retroRec,
    ai_available: planReview.ai_available || retroRec.ai_available,
  };
}
