/**
 * Minimal hand-rolled arg parser (no dependency). Supports the shapes the CLI
 * needs: `ship <command> [subcommand] [--flag value | --flag]`.
 */
export interface ParsedArgs {
  command: string | null;
  sub: string | null;
  flags: Record<string, string | boolean>;
  rest: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(arg);
    }
  }

  return {
    command: positionals[0] ?? null,
    sub: positionals[1] ?? null,
    flags,
    rest: positionals.slice(2),
  };
}
