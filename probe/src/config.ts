import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

export type ProbeConfig = {
  apiUrl: string;
  webUrl?: string;
  email: string;
  password: string;
  allowMutation: boolean;
  keepData: boolean;
  outputDir: string;
  timeoutMs: number;
  runId: string;
  databaseUrl?: string;
};

const DEFAULT_API_URL = 'http://localhost:3000';
const DEFAULT_EMAIL = 'dev@ship.local';
const DEFAULT_PASSWORD = 'admin123';
const DEFAULT_TIMEOUT_MS = 30_000;

function readValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

export function parseConfig(argv: string[] = process.argv.slice(2)): ProbeConfig {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  const apiUrl = normalizeBaseUrl(readValue(argv, '--api-url') ?? process.env.PROBE_API_URL ?? DEFAULT_API_URL);
  const webUrlRaw = readValue(argv, '--web-url') ?? process.env.PROBE_WEB_URL;
  const outputDir = resolve(readValue(argv, '--output-dir') ?? process.env.PROBE_OUTPUT_DIR ?? 'probe/results');
  const timeoutValue = Number(readValue(argv, '--timeout-ms') ?? process.env.PROBE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);

  return {
    apiUrl,
    webUrl: webUrlRaw ? normalizeBaseUrl(webUrlRaw) : undefined,
    email: readValue(argv, '--email') ?? process.env.PROBE_EMAIL ?? DEFAULT_EMAIL,
    password: readValue(argv, '--password') ?? process.env.PROBE_PASSWORD ?? DEFAULT_PASSWORD,
    allowMutation: argv.includes('--allow-mutation') || process.env.PROBE_ALLOW_MUTATION === '1',
    keepData: argv.includes('--keep-data') || process.env.PROBE_KEEP_DATA === '1',
    outputDir,
    timeoutMs: Number.isFinite(timeoutValue) && timeoutValue > 0 ? timeoutValue : DEFAULT_TIMEOUT_MS,
    runId: readValue(argv, '--run-id') ?? `probe-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`,
    databaseUrl: process.env.DATABASE_URL,
  };
}

function printHelp(): void {
  console.log(`Usage:
  pnpm probe -- --api-url http://localhost:3000 --web-url http://localhost:5173 --allow-mutation

Options:
  --api-url <url>       API base URL. Default: ${DEFAULT_API_URL}
  --web-url <url>       Optional web app base URL.
  --email <email>       Login email. Default: ${DEFAULT_EMAIL}
  --password <password> Login password. Default: ${DEFAULT_PASSWORD}
  --allow-mutation      Required for probes that create tokens, invites, users, or DB session changes.
  --keep-data           Keep audit-created data where cleanup is supported.
  --output-dir <dir>    Report output directory. Default: probe/results
  --timeout-ms <ms>     Per-request timeout. Default: ${DEFAULT_TIMEOUT_MS}
  --run-id <id>         Stable run id for namespacing audit-created data.
`);
}
