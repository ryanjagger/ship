import { ShipClient, ShipApiError } from '@ryanjagger/ship-sdk';
import type { CliConfig } from '../config.js';
import { loadCredentials } from '../credentials.js';

/** Build a ShipClient from saved credentials, or null (with a hint) if absent. */
async function requireClient(config: CliConfig): Promise<ShipClient | null> {
  const creds = await loadCredentials();
  if (!creds) {
    console.error('Not signed in. Run `ship login` first.');
    return null;
  }
  return new ShipClient({ token: creds.token, baseUrl: creds.baseUrl || config.baseUrl });
}

function reportError(err: unknown): number {
  if (err instanceof ShipApiError) {
    if (err.status === 401) console.error('Your session has expired. Run `ship login` again.');
    else console.error(`API error (${err.code}): ${err.message}`);
  } else {
    console.error(`Error: ${(err as Error).message}`);
  }
  return 1;
}

export async function docsCreate(config: CliConfig, title: string): Promise<number> {
  const client = await requireClient(config);
  if (!client) return 1;
  try {
    const doc = await client.documents.create({ title });
    console.log(`✓ Created ${doc.document_type} ${doc.id}`);
    console.log(`  ${doc.title}`);
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

export async function docsList(config: CliConfig): Promise<number> {
  const client = await requireClient(config);
  if (!client) return 1;
  try {
    const page = await client.documents.list({ limit: 50 });
    if (page.data.length === 0) {
      console.log('No documents yet. Create one with:  ship docs create --title "…"');
      return 0;
    }
    for (const d of page.data) {
      console.log(`${d.id}  ${d.document_type.padEnd(8)}  ${d.title}`);
    }
    return 0;
  } catch (err) {
    return reportError(err);
  }
}
