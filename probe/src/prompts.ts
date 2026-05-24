import { checkbox, confirm, input, password } from '@inquirer/prompts';
import { loadPortsFile, PROBE_GROUPS, type ProbeConfig, type ProbeGroup } from './config.js';

const GROUP_DESCRIPTIONS: Record<ProbeGroup, string> = {
  preflight: 'API/web reachability, login works, mutation readiness, pnpm audit available',
  auth: 'Login, CSRF, cookie hardening, forged sessions, API tokens, role boundaries',
  websocket: 'Unauth upgrades, malformed /events frames, oversized collaboration frames',
  dependencies: 'pnpm audit → high/critical advisories mapped to Ship feature areas',
  inputs: 'Stored XSS in wiki/issue/comment, reflected XSS, SQLi on search params',
  headers: 'Hostile-origin CORS, baseline security headers, verbose errors, secret paths',
  'rate-limit': 'Safe low-volume bursts on CSRF, login, search; --aggressive forces a 429 proof',
};

/**
 * Drive the operator through prompts for target / credentials / groups / mutation /
 * aggressive-rate-limit. Returns a fully-formed `ProbeConfig` whose semantics are
 * indistinguishable from one built by `parseConfig` with the equivalent flags —
 * downstream probe code cannot tell which path produced it.
 *
 * `baseConfig` provides the defaults (already env-resolved by `parseConfig([])`).
 * `.ports` is consulted for fresher URL defaults when the dev server is running.
 */
export async function promptForConfig(baseConfig: ProbeConfig): Promise<ProbeConfig> {
  const ports = loadPortsFile(baseConfig.repoRoot);

  const apiUrl = await input({
    message: 'API base URL',
    default: ports.api ?? baseConfig.apiUrl,
  });

  const webUrl = await input({
    message: 'Web base URL (optional — press Enter to skip)',
    default: ports.web ?? baseConfig.webUrl ?? '',
  });

  const email = await input({
    message: 'Login email',
    default: baseConfig.email,
  });

  const pwd = await password({
    message: 'Login password',
    mask: '*',
  });

  const groups = await checkbox<ProbeGroup>({
    message: 'Which probe groups should run?',
    choices: PROBE_GROUPS.map((group) => ({
      name: group,
      value: group,
      description: GROUP_DESCRIPTIONS[group],
      checked: true,
    })),
    required: true,
  });

  const allowMutation = await confirm({
    message: [
      'Allow mutating probes?',
      '  Creates test wikis/issues/comments/tokens and members via invite.',
      '  Required for full coverage of auth role boundaries and input sanitization.',
    ].join('\n'),
    default: baseConfig.allowMutation,
  });

  const aggressiveRateLimit = await confirm({
    message: [
      'Force a 429 proof against login rate limiting?',
      '  This will exhaust the login limiter; the test account cannot log in',
      '  for ~15 minutes after. Skip unless you specifically need rate-limit proof.',
    ].join('\n'),
    default: baseConfig.aggressiveRateLimit,
  });

  const onlyGroups = groups.length === PROBE_GROUPS.length ? [] : groups;
  const normalizedWeb = webUrl.trim() ? webUrl.trim().replace(/\/+$/, '') : undefined;
  const normalizedApi = apiUrl.trim().replace(/\/+$/, '');

  return {
    ...baseConfig,
    apiUrl: normalizedApi,
    webUrl: normalizedWeb,
    email,
    password: pwd || baseConfig.password,
    allowMutation,
    aggressiveRateLimit,
    onlyGroups,
    // The checkbox is the single source of truth in interactive mode — clear
    // any PROBE_SKIP env value that parseConfig may have pulled into baseConfig
    // so it doesn't silently mask the operator's explicit selection.
    skipGroups: [],
  };
}
