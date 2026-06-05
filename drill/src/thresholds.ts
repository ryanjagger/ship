/**
 * Timing thresholds for the TTFE drill — the build gate.
 *
 * The issue's hard requirement is total elapsed < 60 s in CI. Per-stage ceilings
 * are generous (CI runners are slower and noisier than a dev laptop) but tight
 * enough that a real contract regression — a slow handshake, a stalled dispatch,
 * an accidental synchronous retry — pushes a stage past its limit and fails the
 * build. Tune these as the baseline settles; keep total at the 60 s contract.
 *
 * Override any ceiling via env (milliseconds), e.g. TTFE_MAX_TOTAL_MS=90000, for
 * a one-off slow runner without editing the gate.
 */
export type Stage = 'install' | 'login' | 'subscribe' | 'trigger' | 'receive' | 'verify';

export const STAGES: Stage[] = ['install', 'login', 'subscribe', 'trigger', 'receive', 'verify'];

const DEFAULTS: Record<Stage, number> = {
  install: 45_000, // pnpm pack + install into a clean temp dir + tsc snippet
  login: 10_000, // device authorization + poll + auto-approve round-trip
  subscribe: 5_000,
  trigger: 5_000,
  receive: 8_000, // first-attempt signed delivery (dispatchSoon fires ~immediately)
  verify: 1_000, // verifyWebhook is < 1 ms; the budget is for the 4 assertions
};

const DEFAULT_TOTAL_MS = 60_000;

function envMs(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function stageLimit(stage: Stage): number {
  return envMs(`TTFE_MAX_${stage.toUpperCase()}_MS`, DEFAULTS[stage]);
}

export function totalLimit(): number {
  return envMs('TTFE_MAX_TOTAL_MS', DEFAULT_TOTAL_MS);
}
