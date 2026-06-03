import { promises as fs } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

/**
 * Local credential store at ~/.ship/credentials.json (0600). Holds the device-
 * flow access token so subsequent `ship` commands don't re-authenticate.
 * SHIP_CONFIG_DIR overrides the directory (used by tests).
 */
export interface Credentials {
  token: string;
  baseUrl: string;
  obtainedAt: string;
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.SHIP_CONFIG_DIR ?? join(homedir(), '.ship');
  return join(dir, 'credentials.json');
}

export async function saveCredentials(creds: Credentials, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const path = credentialsPath(env);
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // 0600: the token is a bearer credential; keep it owner-only.
  await fs.writeFile(path, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  return path;
}

export async function loadCredentials(env: NodeJS.ProcessEnv = process.env): Promise<Credentials | null> {
  try {
    const raw = await fs.readFile(credentialsPath(env), 'utf8');
    const parsed = JSON.parse(raw) as Credentials;
    if (parsed && typeof parsed.token === 'string' && typeof parsed.baseUrl === 'string') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export async function clearCredentials(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    await fs.unlink(credentialsPath(env));
  } catch {
    /* already absent */
  }
}
