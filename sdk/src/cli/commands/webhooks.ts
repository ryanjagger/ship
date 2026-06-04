import type { ShipClient, ShipWebhookDelivery } from '../../index.js';
import type { CliConfig } from '../config.js';
import { requireClient, reportError } from './resources.js';

const USAGE = 'Usage: ship webhooks <list|create|delete|replay|tail>';

type Flags = Record<string, string | boolean>;

function flagStr(flags: Flags, key: string): string | null {
  return typeof flags[key] === 'string' ? (flags[key] as string) : null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function formatDelivery(d: ShipWebhookDelivery): string {
  const time = new Date(d.updated_at).toLocaleTimeString();
  const resp = String(d.last_response_status ?? '-');
  return `${time}  ${d.event_type.padEnd(24)}  ${d.status.padEnd(13)}  ${resp.padEnd(4)}  attempt=${d.attempt_count}  ${d.id}`;
}

async function webhooksList(client: ShipClient): Promise<number> {
  const { data } = await client.webhooks.list();
  if (data.length === 0) {
    console.log('No webhook subscriptions found.');
    return 0;
  }
  for (const s of data) {
    const active = s.active ? 'active  ' : 'inactive';
    console.log(`${s.id}  ${active}  [${s.events.join(', ')}]  ${s.url}`);
  }
  return 0;
}

async function webhooksCreate(client: ShipClient, flags: Flags): Promise<number> {
  const url = flagStr(flags, 'url');
  const eventsRaw = flagStr(flags, 'events');
  if (!url || !eventsRaw) {
    console.error(`Missing --url and/or --events\nUsage: ship webhooks create --url <https://...> --events issue.created,issue.updated`);
    return 1;
  }
  const events = eventsRaw.split(',').map((e) => e.trim()).filter(Boolean);
  const sub = await client.webhooks.create({ url, events });
  console.log(`Created webhook ${sub.id}`);
  console.log(`  url:    ${sub.url}`);
  console.log(`  events: ${sub.events.join(', ')}`);
  console.log('');
  console.log(`  signing secret (shown once — store it now):`);
  console.log(`    ${sub.secret}`);
  return 0;
}

async function webhooksDelete(client: ShipClient, sub: string | null, flags: Flags, rest: string[]): Promise<number> {
  const id = rest[0] ?? flagStr(flags, 'id');
  if (!id) {
    console.error('Missing webhook id\nUsage: ship webhooks delete <id>');
    return 1;
  }
  await client.webhooks.delete(id);
  console.log(`Deleted webhook ${id}`);
  return 0;
}

async function webhooksReplay(client: ShipClient, flags: Flags, rest: string[]): Promise<number> {
  const id = rest[0] ?? flagStr(flags, 'delivery');
  if (!id) {
    console.error('Missing delivery id\nUsage: ship webhooks replay <delivery-id>');
    return 1;
  }
  const result = await client.webhooks.deliveries.replay(id);
  console.log(`Replayed delivery ${result.replay_of_delivery_id} → new delivery ${result.delivery_id}`);
  return 0;
}

async function webhooksTail(client: ShipClient, flags: Flags): Promise<number> {
  const intervalMs = Math.max(1, Number(flagStr(flags, 'interval') ?? 3)) * 1000;
  const params = {
    subscription_id: flagStr(flags, 'subscription') ?? undefined,
    event_type: flagStr(flags, 'event-type') ?? undefined,
    status: (flagStr(flags, 'status') as ShipWebhookDelivery['status'] | null) ?? undefined,
    limit: 50,
  };

  console.error('Tailing webhook deliveries (Ctrl-C to stop)...');
  process.on('SIGINT', () => process.exit(0));

  const seen = new Set<string>();
  let baseline = true;
  // Loop forever; SIGINT exits the process.
  for (;;) {
    try {
      const { data } = await client.webhooks.deliveries.list(params);
      // Newest-first from the API; print fresh ones oldest-first.
      const fresh = data.filter((d) => !seen.has(d.id)).reverse();
      for (const d of fresh) {
        if (!baseline) console.log(formatDelivery(d));
        seen.add(d.id);
      }
      baseline = false;
    } catch (err) {
      return reportError(err);
    }
    await sleep(intervalMs);
  }
}

export async function runWebhooksCommand(
  config: CliConfig,
  sub: string | null,
  flags: Flags,
  rest: string[]
): Promise<number> {
  if (!sub || flags.help) {
    console.error(USAGE);
    return flags.help ? 0 : 1;
  }
  const client = await requireClient(config);
  if (!client) return 1;

  try {
    switch (sub) {
      case 'list':
        return await webhooksList(client);
      case 'create':
        return await webhooksCreate(client, flags);
      case 'delete':
        return await webhooksDelete(client, sub, flags, rest);
      case 'replay':
        return await webhooksReplay(client, flags, rest);
      case 'tail':
        return await webhooksTail(client, flags);
      default:
        console.error(USAGE);
        return 1;
    }
  } catch (err) {
    return reportError(err);
  }
}
