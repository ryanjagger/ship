#!/usr/bin/env tsx
/**
 * Drill harness entrypoint — `pnpm drill <name>`.
 *
 * A "drill" runs a full developer loop end-to-end against a freshly-spawned Ship
 * instance and gates the build on per-stage + total timing thresholds. The first
 * (and headline) drill is `ttfe` — Time-to-First-Event (issue #73). The dispatcher
 * is deliberately tiny so future drills (refresh-token rotation, idempotency replay
 * — both named in docs/plugforge/plugforge-prd.md) slot in beside it.
 */
import { runTtfe } from './ttfe.js';

type DrillFn = () => Promise<{ ok: boolean }>;

const DRILLS: Record<string, DrillFn> = {
  ttfe: runTtfe,
};

async function main(): Promise<void> {
  const name = process.argv[2];

  if (!name || name === '--help' || name === '-h') {
    usage();
    process.exit(name ? 0 : 1);
  }

  const drill = DRILLS[name];
  if (!drill) {
    console.error(`Unknown drill: "${name}"`);
    usage();
    process.exit(1);
  }

  const { ok } = await drill();
  process.exit(ok ? 0 : 1);
}

function usage(): void {
  const names = Object.keys(DRILLS).join(', ');
  console.error(`\nUsage: pnpm drill <name>\n\n  Available drills: ${names}\n`);
}

main().catch((err) => {
  console.error('\n💥 Drill crashed:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
