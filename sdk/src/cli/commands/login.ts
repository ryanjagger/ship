import { spawn } from 'child_process';
import { ShipClient, DeviceFlowError, type DeviceAuthorization, type ITokenStore, type ShipTokenSet } from '../../index.js';
import type { CliConfig } from '../config.js';
import { saveCredentials, credentialsPath } from '../credentials.js';

/**
 * Best-effort: open the verification URL in the user's browser. Skipped in
 * headless/automated contexts — honors `SHIP_NO_BROWSER`, `BROWSER=none`, and
 * `CI` — so the TTFE drill and CI runners don't pop a browser (the verification
 * page is served by the Ship web app, not the API the drill spawns).
 */
function openBrowser(url: string): void {
  if (process.env.SHIP_NO_BROWSER || process.env.BROWSER === 'none' || process.env.CI) {
    return;
  }
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {
      /* ignore: the URL is already printed for manual use */
    });
    child.unref();
  } catch {
    /* ignore */
  }
}

/**
 * A `FileTokenStore`-shaped store that persists to the CLI's existing
 * `~/.ship/credentials.json` (so other `ship` commands keep reading
 * `{ token, baseUrl }`). It adapts the SDK `ShipTokenSet` to the CLI record.
 */
function cliCredentialStore(baseUrl: string): ITokenStore {
  return {
    async get(): Promise<ShipTokenSet | null> {
      return null; // login always re-authenticates; no need to read back here.
    },
    async set(tokens: ShipTokenSet): Promise<void> {
      await saveCredentials({ token: tokens.accessToken, baseUrl, obtainedAt: new Date().toISOString() });
    },
    async clear(): Promise<void> {
      /* handled by `ship logout` elsewhere */
    },
  };
}

/** `ship login` — OAuth 2.0 Device Authorization Grant (RFC 8628). */
export async function login(config: CliConfig): Promise<number> {
  try {
    await ShipClient.deviceLogin({
      baseUrl: config.baseUrl,
      clientId: config.clientId,
      scope: 'documents:read documents:write webhooks:manage people:read',
      store: cliCredentialStore(config.baseUrl),
      onUserCode: (auth: DeviceAuthorization) => {
        console.log('\nTo sign in, open this page in your browser:\n');
        console.log(`  ${auth.verification_uri}`);
        console.log(`\nand enter the code:  ${auth.user_code}\n`);
        console.log(`(or open the direct link: ${auth.verification_uri_complete} )\n`);
        console.log('Waiting for approval...');
        openBrowser(auth.verification_uri_complete);
      },
    });

    console.log(`\nSigned in. Token saved to ${credentialsPath()}`);
    console.log('  (tokens are short-lived; re-run `ship login` when a command reports an expired token.)');
    return 0;
  } catch (err) {
    if (err instanceof DeviceFlowError) {
      console.error(`\nLogin failed: ${err.error}${err.description ? ` - ${err.description}` : ''}`);
    } else {
      console.error(`\nLogin failed: ${(err as Error).message}`);
    }
    return 1;
  }
}
