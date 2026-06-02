/**
 * CLI configuration, resolved from the environment with first-party defaults.
 *
 * `baseUrl` points at the Ship API. In local dev the API listens on :3000; set
 * SHIP_API_URL to your deployment for anything else. The /device approval page
 * the user visits is built server-side from PUBLIC_BASE_URL (set that to the web
 * origin — e.g. http://localhost:5173 — when API and web are on split ports).
 */
export interface CliConfig {
  baseUrl: string;
  clientId: string;
}

const DEFAULT_BASE_URL = 'http://localhost:3000';
const DEFAULT_CLIENT_ID = 'client_ship_cli';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CliConfig {
  return {
    baseUrl: (env.SHIP_API_URL ?? DEFAULT_BASE_URL).replace(/\/$/, ''),
    clientId: env.SHIP_CLIENT_ID ?? DEFAULT_CLIENT_ID,
  };
}
