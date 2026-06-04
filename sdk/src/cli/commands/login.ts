import { spawn } from 'child_process';
import { requestDeviceAuthorization, pollDeviceToken, DeviceFlowError } from '../../index.js';
import type { CliConfig } from '../config.js';
import { saveCredentials } from '../credentials.js';

/** Best-effort: open the verification URL in the user's browser. */
function openBrowser(url: string): void {
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

/** `ship login` — OAuth 2.0 Device Authorization Grant (RFC 8628). */
export async function login(config: CliConfig): Promise<number> {
  try {
    const auth = await requestDeviceAuthorization({
      baseUrl: config.baseUrl,
      clientId: config.clientId,
      scope: 'documents:read documents:write webhooks:manage people:read',
    });

    console.log('\nTo sign in, open this page in your browser:\n');
    console.log(`  ${auth.verification_uri}`);
    console.log(`\nand enter the code:  ${auth.user_code}\n`);
    console.log(`(or open the direct link: ${auth.verification_uri_complete} )\n`);
    console.log('Waiting for approval...');
    openBrowser(auth.verification_uri_complete);

    const token = await pollDeviceToken({
      baseUrl: config.baseUrl,
      clientId: config.clientId,
      deviceCode: auth.device_code,
      intervalSeconds: auth.interval,
    });

    const path = await saveCredentials({
      token: token.access_token,
      baseUrl: config.baseUrl,
      obtainedAt: new Date().toISOString(),
    });

    console.log(`\nSigned in. Token saved to ${path}`);
    console.log(`  (expires in ~${Math.round(token.expires_in / 60)} min; re-run \`ship login\` after that.)`);
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
