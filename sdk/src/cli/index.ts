#!/usr/bin/env node
import { loadConfig } from './config.js';
import { parseArgs } from './args.js';
import { login } from './commands/login.js';
import { docsCreate, docsList } from './commands/docs.js';
import { findResourceCommand, runResourceCommand } from './commands/resources.js';

const HELP = `ship - Ship Platform CLI

Usage:
  ship login                       Sign in via OAuth device flow (opens a browser)
  ship issues list                 List issues
  ship issues create --title "..." Create an issue
  ship projects list               List projects
  ship sprints list                List sprints
  ship wiki list                   List wiki pages
  ship docs list                   Legacy broad document list

Environment:
  SHIP_API_URL     Ship API base URL   (default Railway development deployment)
  SHIP_CLIENT_ID   OAuth client_id     (default client_ship_cli)
`;

export async function run(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { command, sub, flags } = parseArgs(argv);
  const config = loadConfig(env);

  if (!command || command === 'help' || flags.help) {
    console.log(HELP);
    return command && command !== 'help' ? 1 : 0;
  }

  switch (command) {
    case 'login':
      return login(config);
    case 'docs':
      if (sub === 'create') {
        const title = typeof flags.title === 'string' ? flags.title : 'Untitled';
        return docsCreate(config, title);
      }
      if (sub === 'list') return docsList(config);
      console.error('Usage: ship docs <create|list>');
      return 1;
    default:
      {
        const resource = findResourceCommand(command);
        if (resource) return runResourceCommand(config, resource, sub, flags);
      }
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      return 1;
  }
}

run(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
