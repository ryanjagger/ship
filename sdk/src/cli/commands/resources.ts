import { ShipApiError, ShipClient, TypedResourceClient } from '../../index.js';
import type { CliConfig } from '../config.js';
import { loadCredentials } from '../credentials.js';

type ClientKey =
  | 'wikiPages'
  | 'issues'
  | 'programs'
  | 'projects'
  | 'sprints'
  | 'people'
  | 'weeklyPlans'
  | 'weeklyRetros'
  | 'standups'
  | 'weeklyReviews';

export interface ResourceCommandConfig {
  command: string;
  clientKey: ClientKey;
  label: string;
}

export const RESOURCE_COMMANDS: ResourceCommandConfig[] = [
  { command: 'wiki', clientKey: 'wikiPages', label: 'wiki page' },
  { command: 'wiki-pages', clientKey: 'wikiPages', label: 'wiki page' },
  { command: 'issues', clientKey: 'issues', label: 'issue' },
  { command: 'programs', clientKey: 'programs', label: 'program' },
  { command: 'projects', clientKey: 'projects', label: 'project' },
  { command: 'sprints', clientKey: 'sprints', label: 'sprint' },
  { command: 'people', clientKey: 'people', label: 'person' },
  { command: 'weekly-plans', clientKey: 'weeklyPlans', label: 'weekly plan' },
  { command: 'weekly-retros', clientKey: 'weeklyRetros', label: 'weekly retro' },
  { command: 'standups', clientKey: 'standups', label: 'standup' },
  { command: 'weekly-reviews', clientKey: 'weeklyReviews', label: 'weekly review' },
];

export function findResourceCommand(command: string | null): ResourceCommandConfig | undefined {
  if (!command) return undefined;
  return RESOURCE_COMMANDS.find((resource) => resource.command === command);
}

export async function requireClient(config: CliConfig): Promise<ShipClient | null> {
  const creds = await loadCredentials();
  if (!creds) {
    console.error('Not signed in. Run `ship login` first.');
    return null;
  }
  return new ShipClient({ token: creds.token, baseUrl: creds.baseUrl || config.baseUrl });
}

export function reportError(err: unknown): number {
  if (err instanceof ShipApiError) {
    if (err.status === 401) console.error('Your session has expired. Run `ship login` again.');
    else if (err.status === 403 && err.details?.required_scope === 'webhooks:manage') {
      console.error('Insufficient scope: webhooks requires `webhooks:manage`. Run `ship login` again to refresh your token.');
    } else console.error(`API error (${err.code}): ${err.message}`);
  } else {
    console.error(`Error: ${(err as Error).message}`);
  }
  return 1;
}

type ResourceItem = {
  id: string;
  title?: string;
  name?: string;
  display_id?: string;
  state?: string;
  priority?: string;
  status?: string;
  sprint_number?: number;
};

type CliResourceClient = TypedResourceClient<ResourceItem, Record<string, unknown>, Record<string, unknown>>;

function getClient(client: ShipClient, key: ClientKey): CliResourceClient {
  return client[key] as unknown as CliResourceClient;
}

function usage(resource: ResourceCommandConfig): string {
  return `Usage: ship ${resource.command} <list|get|create|update|delete>`;
}

function titleOf(item: ResourceItem): string {
  return item.title ?? item.name ?? '(untitled)';
}

function formatListItem(resource: ResourceCommandConfig, item: ResourceItem): string {
  if (resource.clientKey === 'issues') {
    return `${item.id}  ${(item.display_id ?? '').padEnd(8)}  ${(item.state ?? '').padEnd(12)}  ${item.priority ?? ''}  ${titleOf(item)}`;
  }
  if (resource.clientKey === 'sprints') {
    const number = item.sprint_number != null ? `#${item.sprint_number}` : '';
    return `${item.id}  ${number.padEnd(6)}  ${(item.status ?? '').padEnd(10)}  ${titleOf(item)}`;
  }
  return `${item.id}  ${titleOf(item)}`;
}

function buildCreateInput(resource: ResourceCommandConfig, flags: Record<string, string | boolean>): Record<string, unknown> | null {
  const title = typeof flags.title === 'string' ? flags.title : 'Untitled';
  if (resource.clientKey === 'sprints') {
    if (typeof flags['sprint-number'] !== 'string') return null;
    return { title, sprint_number: Number(flags['sprint-number']) };
  }
  if (resource.clientKey === 'people') {
    return { name: typeof flags.name === 'string' ? flags.name : title };
  }
  return { title };
}

export async function runResourceCommand(
  config: CliConfig,
  resource: ResourceCommandConfig,
  sub: string | null,
  flags: Record<string, string | boolean>
): Promise<number> {
  if (!sub || flags.help) {
    console.error(usage(resource));
    return flags.help ? 0 : 1;
  }

  const client = await requireClient(config);
  if (!client) return 1;
  const api = getClient(client, resource.clientKey);

  try {
    if (sub === 'list') {
      const page = await api.list({ limit: typeof flags.limit === 'string' ? Number(flags.limit) : 50 });
      if (page.data.length === 0) {
        console.log(`No ${resource.label}s found.`);
        return 0;
      }
      for (const item of page.data) {
        console.log(formatListItem(resource, item));
      }
      return 0;
    }

    if (sub === 'get') {
      const id = typeof flags.id === 'string' ? flags.id : null;
      if (!id) {
        console.error(`Missing --id\n${usage(resource)}`);
        return 1;
      }
      const item = await api.get(id);
      console.log(JSON.stringify(item, null, 2));
      return 0;
    }

    if (sub === 'create') {
      const input = buildCreateInput(resource, flags);
      if (!input) {
        console.error(`Missing --sprint-number\n${usage(resource)}`);
        return 1;
      }
      const item = await api.create(input);
      console.log(`Created ${resource.label} ${item.id}`);
      console.log(`  ${titleOf(item)}`);
      return 0;
    }

    if (sub === 'update') {
      const id = typeof flags.id === 'string' ? flags.id : null;
      if (!id) {
        console.error(`Missing --id\n${usage(resource)}`);
        return 1;
      }
      const title = typeof flags.title === 'string' ? flags.title : undefined;
      if (!title) {
        console.error(`Nothing to update. Pass --title for now.\n${usage(resource)}`);
        return 1;
      }
      const item = await api.update(id, { title });
      console.log(`Updated ${resource.label} ${item.id}`);
      console.log(`  ${titleOf(item)}`);
      return 0;
    }

    if (sub === 'delete') {
      const id = typeof flags.id === 'string' ? flags.id : null;
      if (!id) {
        console.error(`Missing --id\n${usage(resource)}`);
        return 1;
      }
      await api.delete(id);
      console.log(`Deleted ${resource.label} ${id}`);
      return 0;
    }

    console.error(usage(resource));
    return 1;
  } catch (err) {
    return reportError(err);
  }
}
