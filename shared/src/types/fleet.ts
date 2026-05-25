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

// A single review finding — one per failed deterministic check or rubric criterion.
export interface FleetFinding {
  // Stable identifier for the check/criterion (e.g. 'missing_timeframe', 'quantifiable_target').
  id: string;
  // Human-readable criterion name (e.g. "Timeframe", "Quantifiable target").
  label: string;
  // What is missing or why the criterion did not pass.
  message: string;
}

// Plan-review sub-result (Project Details card).
export interface FleetPlanReview {
  status: FleetStatus;
  // Count of rubric criteria met (0–7) when a provider scored it; null in
  // deterministic-only mode (no faked score).
  score: number | null;
  findings: FleetFinding[];
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
