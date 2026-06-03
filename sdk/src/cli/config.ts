/**
 * CLI configuration, resolved from the environment with first-party defaults.
 *
 * `baseUrl` points at the Ship deployment origin. The published CLI defaults to
 * the current Railway development deployment so the TTFE drill works without an
 * environment variable; SHIP_API_URL remains the override for local dev,
 * staging, or the future production origin.
 */
export interface CliConfig {
  baseUrl: string;
  clientId: string;
}

export const DEFAULT_BASE_URL = 'https://ship-app-development-development.up.railway.app';
const DEFAULT_CLIENT_ID = 'client_ship_cli';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CliConfig {
  return {
    baseUrl: (env.SHIP_API_URL ?? DEFAULT_BASE_URL).replace(/\/$/, ''),
    clientId: env.SHIP_CLIENT_ID ?? DEFAULT_CLIENT_ID,
  };
}
