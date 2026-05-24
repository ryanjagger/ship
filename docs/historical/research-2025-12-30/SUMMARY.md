# pnpm Monorepo Research Summary

## Research Completed: 2025-12-30

This research covers best practices for setting up a pnpm monorepo with Express API + React/Vite + Shared TypeScript types, with a focus on **worktree isolation** for concurrent development.

## Key Findings

### 1. Workspace Configuration (pnpm-workspace.yaml)
- Simple YAML file listing package directories
- Supports wildcards for scalability
- Must exist in repository root

### 2. Shared TypeScript Types Pattern
- Create dedicated `@ship/shared` package
- Export types, constants, and utilities
- Reference via `workspace:*` protocol
- Build to `dist/` for consumption

### 3. TypeScript Project References
- Enable fast incremental builds
- Cross-package type checking
- IDE "Go to Definition" support
- Each package references dependencies

### 4. Development Scripts
- pnpm built-in: `--parallel --recursive --filter`
- Alternative: Turborepo for larger repos
- Watch mode for shared package during development

### 5. Worktree Isolation (Critical Feature)
**Problem:** Multiple worktrees conflict on ports, databases, and processes

**Solution:**
- Auto-generate unique ports per worktree (hash-based)
- Separate database per worktree (branch-name-based)
- `.env.local` files generated per worktree (gitignored)
- Initialization script automates configuration

**Implementation:**
```bash
./scripts/worktree-init.sh  # Auto-configures everything
./scripts/check-ports.sh    # Verifies isolation
```

## Files Created

All configuration files are ready to use in `/Users/corcoss/code/ship/research/configs/`:

### Root Configuration
```
configs/
├── README.md                    # Complete setup guide
├── pnpm-workspace.yaml         # Workspace definition
├── package.json                # Root scripts and metadata
├── tsconfig.json               # Base TypeScript config
└── .gitignore                  # Ignore patterns
```

### Shared Package (@ship/shared)
```
configs/shared/
├── package.json                # Package metadata with exports
├── tsconfig.json              # TS config with composite: true
└── src/
    ├── index.ts               # Main entry point
    ├── constants.ts           # Shared constants
    └── types/
        ├── index.ts           # Re-export all types
        ├── user.ts            # User types
        └── api.ts             # API response types
```

### API Package (@ship/api)
```
configs/api/
├── package.json               # API dependencies + scripts
├── tsconfig.json             # Extends root, references shared
├── .env.template             # Template (checked into git)
└── src/
    └── index.ts              # Express server with shared types
```

### Web Package (@ship/web)
```
configs/web/
├── package.json              # React + Vite dependencies
├── tsconfig.json            # Extends root, references shared
├── vite.config.ts           # Vite configuration with env loading
├── .env.template            # Template (checked into git)
├── index.html               # HTML entry point
└── src/
    ├── main.tsx             # React entry point
    └── App.tsx              # Example using shared types
```

### Scripts
```
configs/scripts/
├── worktree-init.sh         # Initialize worktree with unique config
└── check-ports.sh           # Check active worktrees and ports
```

## Quick Start

```bash
# 1. Copy configs to your project
cp -r /Users/corcoss/code/ship/research/configs/* /path/to/ship/

# 2. Make scripts executable
chmod +x /path/to/ship/scripts/*.sh

# 3. Install dependencies
cd /path/to/ship
pnpm install

# 4. Initialize worktree (generates .env.local with unique ports)
./scripts/worktree-init.sh

# 5. Build shared types
pnpm run build:shared

# 6. Start development
pnpm run dev
```

## Worktree Workflow

```bash
# Create new worktree
git worktree add ../ship-feature-x -b feature-x

# Switch to worktree
cd ../ship-feature-x

# Initialize (auto-generates unique ports/database)
./scripts/worktree-init.sh

# Install and run (no conflicts with main worktree!)
pnpm install
pnpm run dev
```

## Key Commands

```bash
# Development
pnpm run dev              # All packages in parallel
pnpm run dev:api          # API only
pnpm run dev:web          # Web only
pnpm run dev:shared       # Shared types (watch mode)

# Building
pnpm run build            # All packages
pnpm run build:shared     # Shared types first
pnpm run build:api        # API (after shared)
pnpm run build:web        # Web (after shared)

# Worktree Management
pnpm run worktree:init    # Generate unique config
pnpm run worktree:status  # Check ports and databases

# Package-specific
pnpm --filter @ship/api <script>
pnpm --filter @ship/web <script>
```

## Technical Details

### Port Allocation Strategy
```javascript
// Hash worktree path for consistent port assignment
HASH = md5(worktree_path).substring(0, 4)
PORT_OFFSET = parseInt(HASH, 16) % 1000

API_PORT = 3000 + PORT_OFFSET    // 3000-3999
WEB_PORT = 5173 + PORT_OFFSET    // 5173-6172
```

### Database Naming
```bash
# Sanitize branch name to valid database name
ship_main               # main branch
ship_feature_123        # feature-123 branch
ship_fix_bug_456        # fix/bug-456 branch
```

### Environment Variable Loading
```
Priority (highest to lowest):
1. .env.local (per worktree, gitignored)
2. .env.template (checked in, defaults)
3. Default values in code
```

## Architecture Patterns

### TypeScript Monorepo Pattern
```
Root tsconfig.json (base config)
  ├── api/tsconfig.json (extends + references shared)
  ├── web/tsconfig.json (extends + references shared)
  └── shared/tsconfig.json (extends + composite)
```

### Package Dependencies
```
shared (no dependencies)
  ├── api (depends on shared via workspace:*)
  └── web (depends on shared via workspace:*)
```

### Build Order
```
1. shared (build types)
2. api + web (parallel, both depend on shared)
```

## Sources Consulted

1. **Official pnpm Documentation**
   - https://pnpm.io/workspaces
   - Workspace protocol and configuration

2. **Vercel Turborepo Examples**
   - https://github.com/vercel/turbo/tree/main/examples
   - Real-world pnpm monorepo patterns

3. **TypeScript Handbook**
   - https://www.typescriptlang.org/docs/handbook/project-references.html
   - Project references and composite builds

4. **Industry Patterns**
   - GitHub repositories with 1000+ stars
   - Express + React monorepo architectures
   - Git worktree isolation strategies

## Anti-Patterns Identified

1. Using relative imports instead of package names
2. Committing `.env.local` files to git
3. Hardcoding ports in source code
4. Sharing databases between worktrees
5. Not building shared package before consuming packages
6. Using `link-workspace-packages: false`

## Recommendations by Priority

### Must Have
- [x] `pnpm-workspace.yaml` configuration
- [x] Shared package with TypeScript types
- [x] TypeScript project references
- [x] Worktree initialization script
- [x] Environment variable templates

### Recommended
- [ ] Turborepo for build orchestration
- [ ] ESLint shared configuration
- [ ] Prettier for formatting
- [ ] Changesets for versioning

### Optional
- [ ] Docker multi-stage builds
- [ ] GitHub Actions CI/CD
- [ ] Husky for git hooks
- [ ] Vitest/Jest for testing

## Full Documentation

See `/Users/corcoss/code/ship/research/pnpm-monorepo-best-practices.md` for comprehensive research notes including:
- Detailed patterns and rationale
- Code examples and snippets
- Deployment strategies
- Troubleshooting guide
- Resource links

See `/Users/corcoss/code/ship/research/configs/README.md` for complete setup instructions and usage guide.
