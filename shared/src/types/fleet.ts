// Fleet — Project Plan Review types
//
// Fleet reviews a project's Plan (properties.plan) for testability and, at retro
// time, recommends (never decides) validated / invalidated / insufficient-evidence.
// These types describe the API response shape shared between api and web. The
// provider-facing zod schemas live in the api package (fleet-ai / fleet-service).

// Plan-review status shown on the Project Details card.
export type FleetStatus = 'no_plan' | 'needs_work' | 'looks_testable';

// Retro recommendation outcome. Advisory only — never auto-applied to plan_validated.
export type FleetRecommendation =
  | 'validated_recommended'
  | 'invalidated_recommended'
  | 'insufficient_evidence';

// The pieces of a testable bet: "what will change, for whom, by how much, by when".
// `by_when` is satisfied by the project's Target Date (a structured field), not by
// parsing the plan text. `what_changes`/`for_whom`/`by_how_much` are AI-judged when a
// provider is configured; deterministic mode evaluates only what it can detect.
export type FleetPieceId = 'what_changes' | 'by_how_much' | 'for_whom' | 'by_when';

export interface FleetHypothesisPiece {
  id: FleetPieceId;
  // Short label shown when the piece is satisfied (e.g. "What will change").
  label: string;
  met: boolean;
  // Actionable hint shown when the piece is missing (e.g. "Set a Target Date").
  hint: string;
}

// Plan-review sub-result (Project Details card). A "good hypothesis" check: is the
// plan a testable bet? No numeric score — just the status and which pieces are met.
export interface FleetPlanReview {
  status: FleetStatus;
  // The testable-bet pieces that were evaluated (4 with AI, fewer in deterministic mode).
  pieces: FleetHypothesisPiece[];
  // Optional model-suggested rewrite of the plan as a testable bet.
  suggested_rewrite: string | null;
  // True when the AI provider contributed to this sub-result.
  ai_available: boolean;
  // ISO timestamp of when the cached AI sub-result was computed, when present.
  computed_at?: string;
}

// A confirmable write Fleet proposes the user apply to close the retro. Fleet
// stays advisory: it proposes, the human confirms (the write executes under the
// user's own permissions, audited as agent_initiated). Today the only action is
// setting the retro outcome (plan_validated).
export interface FleetProposedAction {
  kind: 'set_plan_validated';
  // The value the confirmed write would set on the project.
  plan_validated: boolean;
  // Human-readable one-liner for the confirm UI.
  summary: string;
}

// Retro recommendation sub-result (Project Retro panel).
export interface FleetRetroRecommendation {
  recommendation: FleetRecommendation;
  explanation: string;
  evidence_found: string[];
  evidence_missing: string[];
  // Short suggested retro conclusion (advisory).
  suggested_conclusion: string | null;
  // One-sentence diagnosis of why the evidence is/isn't sufficient. Null when
  // the model did not contribute (unavailable / degraded).
  diagnosis: string | null;
  // A single concrete next action to take before closing the retro. Null when
  // the model did not contribute.
  recommended_next_action: string | null;
  // The confirmable outcome write Fleet suggests, or null (insufficient evidence
  // proposes nothing, and the unavailable result carries none).
  proposed_action: FleetProposedAction | null;
  ai_available: boolean;
  computed_at?: string;
}

// ── Dedup-on-create (Fleet duplicate-issue check) ──────────────────────────
//
// Two-stage feature. Stage 1 (cheap, per-keystroke): pg_trgm title similarity
// surfaces candidate open issues (GET /api/issues/similar). Stage 2 (on-demand,
// graph-backed): the FleetGraph `dedup` mode reasons over the draft title + the
// candidates and returns a verdict — which candidates are *true* duplicates vs
// merely similar, why, and what the author should do
// (POST /api/fleetgraph/dedup-review).

// A candidate open issue considered for duplication (stage-1 retrieval shape).
export interface FleetDedupCandidate {
  id: string;
  title: string;
  ticket_number: number;
  display_id: string;
  state: string;
  priority: string;
  assignee_name: string | null;
  // Parent project title, when the issue belongs to one (helps weight "same
  // project ⇒ more likely a true duplicate").
  project_title: string | null;
  updated_at: string;
  // pg_trgm similarity score (0–1) against the draft title.
  score: number;
}

// One candidate the model judged a likely duplicate, with its reasoning.
export interface FleetDedupMatch {
  // The candidate issue judged to be a likely duplicate.
  candidate: FleetDedupCandidate;
  confidence: 'high' | 'medium' | 'low';
  // One-sentence reason this is (or isn't quite) the same issue.
  reason: string;
}

// Full response for POST /api/fleetgraph/dedup-review. When no candidates exist
// the verdict short-circuits (no model call): matches=[], summary=null.
export interface FleetDedupReview {
  // All open issues considered (the stage-1 candidates), so the client can show
  // context even when the model flags none as duplicates.
  candidates: FleetDedupCandidate[];
  // The subset the model judged likely duplicates, ranked, with reasons.
  matches: FleetDedupMatch[];
  // One-line overall verdict, or null when there was nothing to judge / degraded.
  summary: string | null;
  // What the author should do (e.g. "Open #42 instead of filing this").
  recommendation: string | null;
  // True when the model contributed (vs. unavailable / degraded / no candidates).
  ai_available: boolean;
}

// Full response for GET /api/projects/:id/fleet/plan-review.
export interface FleetReviewResponse {
  plan_review: FleetPlanReview;
  retro_recommendation: FleetRetroRecommendation;
  // True when an AI provider is configured and was used for at least one sub-result.
  ai_available: boolean;
}
