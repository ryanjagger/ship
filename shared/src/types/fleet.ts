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

// Retro recommendation sub-result (Project Retro panel).
export interface FleetRetroRecommendation {
  recommendation: FleetRecommendation;
  explanation: string;
  evidence_found: string[];
  evidence_missing: string[];
  // Short suggested retro conclusion (advisory).
  suggested_conclusion: string | null;
  ai_available: boolean;
  computed_at?: string;
}

// Full response for GET /api/projects/:id/fleet/plan-review.
export interface FleetReviewResponse {
  plan_review: FleetPlanReview;
  retro_recommendation: FleetRetroRecommendation;
  // True when an AI provider is configured and was used for at least one sub-result.
  ai_available: boolean;
}
