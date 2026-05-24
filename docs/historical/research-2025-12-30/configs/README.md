# Ship - pnpm Monorepo Setup

Production-ready pnpm monorepo configuration for Express API + React/Vite + Shared TypeScript types, with full worktree isolation support.

## Quick Start

```bash
# 1. Copy all config files to your ship/ directory
cp -r configs/* /path/to/ship/

# 2. Install dependencies
cd /path/to/ship
pnpm install

# 3. Build shared types first
pnpm run build:shared

# 4. Start development servers
pnpm run dev
```

## Project Structure

```
ship/
├── api/                     # Express backend
│   ├── src/
│   │   └── index.ts        # API server entry point
│   ├── package.json
│   ├── tsconfig.json
│   ├── .env.template       # Checked into git
│   └── .env.local          # Generated per worktree (gitignored)
│
├── web/                     # React + Vite frontend
│   ├── src/
│   │   ├── App.tsx
│   │   └── main.tsx
│   ├── index.html
│   ├── vite.config.ts
│   ├── package.json
│   ├── tsconfig.json
│   ├── .env.template
│   └── .env.local          # Generated per worktree (gitignored)
│
├── shared/                  # Shared TypeScript types
│   ├── src/
│   │   ├── types/
│   │   │   ├── user.ts
│   │   │   ├── api.ts
│   │   │   └── index.ts
│   │   ├── constants.ts
│   │   └── index.ts
│   ├── dist/               # Built output (consumed by api/web)
│   ├── package.json
│   └── tsconfig.json
│
├── scripts/
│   ├── worktree-init.sh    # Initialize new worktree
│   └── check-ports.sh      # Check worktree status
│
├── package.json            # Root workspace config
├── pnpm-workspace.yaml     # Workspace definition
├── tsconfig.json           # Base TypeScript config
└── .gitignore
```

## Worktree Isolation

The key feature of this setup is the ability to run multiple git worktrees simultaneously without conflicts.

### How It Works

1. **Dynamic Ports**: Each worktree gets unique ports based on a hash of its path
2. **Isolated Databases**: Each worktree has its own PostgreSQL database
3. **Environment Separation**: `.env.local` files are generated per worktree
4. **Process Isolation**: No PID file or lock file conflicts

### Creating and Using Worktrees

```bash
# Create a new worktree for a feature branch
git worktree add ../ship-feature-123 -b feature-123

# Switch to the new worktree
cd ../ship-feature-123

# Initialize worktree configuration (generates unique ports/database)
./scripts/worktree-init.sh

# Install dependencies
pnpm install

# Start development servers
pnpm run dev
```

### Worktree Init Script

The `scripts/worktree-init.sh` script automatically:
- Calculates unique ports based on worktree path hash
- Generates sanitized database name from branch name
- Creates `.env.local` files for api and web
- Creates PostgreSQL database if it doesn't exist

**Example output:**
```
=== Worktree Initialization ===
Worktree: ship-feature-123
Branch: feature-123

Generating configuration...
  API Port: 3456
  Web Port: 5629
  Database: ship_feature_123

Configuration files created:
  - api/.env.local
  - web/.env.local
```

### Checking Worktree Status

```bash
# See all worktrees and their port/database usage
./scripts/check-ports.sh
```

**Example output:**
```
=== Worktree Status Check ===

Active Git Worktrees:
/Users/you/ship       abc123 [main]
/Users/you/ship-feature-123  def456 [feature-123]

Port Usage (API range 3000-4000):
  node 12345 localhost:3000
  node 67890 localhost:3456

Port Usage (Web range 5173-6173):
  node 12346 localhost:5173
  node 67891 localhost:5629

Ship Databases:
  ship_main
  ship_feature_123

Worktree Configuration:
  api/.env.local: ✓ exists
    API Port: 3456
  web/.env.local: ✓ exists
    Web Port: 5629
```

## Development Workflow

### Standard Development (Single Worktree)

```bash
# Start all packages in watch mode
pnpm run dev

# Or start individually
pnpm run dev:api    # API only
pnpm run dev:web    # Web only
pnpm run dev:shared # Shared types in watch mode
```

### Parallel Development (Multiple Worktrees)

```bash
# Terminal 1: Main branch
cd ~/ship
./scripts/worktree-init.sh  # If not already done
pnpm run dev
# API: http://localhost:3000
# Web: http://localhost:5173

# Terminal 2: Feature branch
cd ~/ship-feature-123
./scripts/worktree-init.sh
pnpm run dev
# API: http://localhost:3456 (auto-calculated)
# Web: http://localhost:5629 (auto-calculated)
# Database: ship_feature_123 (isolated)
```

Both environments run simultaneously without conflicts!

## Shared TypeScript Types

The `@ship/shared` package contains all shared types, constants, and utilities.

### Adding New Types

```typescript
// shared/src/types/product.ts
export interface Product {
  id: string;
  name: string;
  price: number;
}

// shared/src/types/index.ts
export * from './product.js';
```

### Using Shared Types

**In API:**
```typescript
import type { User, ApiResponse } from '@ship/shared';

app.get('/api/users', (req, res) => {
  const users: User[] = [...];
  const response: ApiResponse<User[]> = {
    success: true,
    data: users,
  };
  res.json(response);
});
```

**In Web:**
```typescript
import { useState } from 'react';
import type { User, ApiResponse } from '@ship/shared';

function UserList() {
  const [users, setUsers] = useState<User[]>([]);

  fetch('/api/users')
    .then(res => res.json())
    .then((data: ApiResponse<User[]>) => {
      if (data.success && data.data) {
        setUsers(data.data);
      }
    });
}
```

### Building Shared Package

The shared package must be built before the consuming packages can use it:

```bash
# Build once
pnpm run build:shared

# Or watch mode during development
pnpm run dev:shared
```

The `api` and `web` packages reference the compiled output in `shared/dist/`.

## Scripts Reference

**Root level:**
```bash
pnpm run dev              # Start all packages in parallel
pnpm run dev:api          # Start API only
pnpm run dev:web          # Start Web only
pnpm run dev:shared       # Build shared types in watch mode

pnpm run build            # Build all packages
pnpm run build:shared     # Build shared types only
pnpm run build:api        # Build API (after shared)
pnpm run build:web        # Build Web (after shared)

pnpm run type-check       # Type check all packages
pnpm run lint             # Lint all packages
pnpm run clean            # Clean all build artifacts

pnpm run worktree:init    # Initialize worktree config
pnpm run worktree:status  # Check worktree status
```

**API package:**
```bash
pnpm --filter @ship/api dev          # Start dev server
pnpm --filter @ship/api build        # Build for production
pnpm --filter @ship/api type-check   # Type check only
```

**Web package:**
```bash
pnpm --filter @ship/web dev          # Start Vite dev server
pnpm --filter @ship/web build        # Build for production
pnpm --filter @ship/web preview      # Preview production build
```

## TypeScript Configuration

### Project References

This monorepo uses TypeScript project references for:
- Fast incremental builds
- Cross-package type checking
- IDE "Go to Definition" across packages

Each package's `tsconfig.json` includes:
```json
{
  "references": [
    { "path": "../shared" }
  ]
}
```

### Path Aliases

Instead of relative imports, use package names:

```typescript
// ✓ Good
import type { User } from '@ship/shared';

// ✗ Bad
import type { User } from '../../shared/src/types/user';
```

This works because:
1. Packages reference each other via `workspace:*` in `package.json`
2. pnpm creates symlinks in `node_modules/@ship/*`
3. TypeScript resolves via `node_modules`

## Build and Deployment

### Development Build
```bash
pnpm run build
```

This builds all packages in dependency order:
1. `shared` (no dependencies)
2. `api` (depends on shared)
3. `web` (depends on shared)

### Production Deployment

**Option 1: Deploy Separately**
```bash
# Build everything
pnpm run build

# Deploy API (e.g., to Elastic Beanstalk)
cd api
eb deploy

# Deploy Web (e.g., to S3 + CloudFront)
cd web
aws s3 sync dist/ s3://your-bucket/
```

**Option 2: Docker**
```dockerfile
FROM node:20 AS builder
WORKDIR /app

# Copy workspace files
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY api/package.json ./api/
COPY web/package.json ./web/
COPY shared/package.json ./shared/

# Install dependencies
RUN corepack enable
RUN pnpm install --frozen-lockfile

# Copy source
COPY . .

# Build
RUN pnpm run build

# Production API image
FROM node:20-slim AS api
WORKDIR /app
COPY --from=builder /app/api/dist ./
COPY --from=builder /app/api/package.json ./
COPY --from=builder /app/shared/dist ./node_modules/@ship/shared/dist/
CMD ["node", "index.js"]
```

## Database Management

### Per-Worktree Databases

Each worktree gets its own database:
- `main` branch → `ship_main`
- `feature-123` branch → `ship_feature_123`
- `fix/bug-456` branch → `ship_fix_bug_456`

### Running Migrations

```bash
# Migrations run against the database specified in .env.local
cd api
pnpm run db:migrate
```

### Cleaning Up Old Databases

```bash
# List all ship databases
psql -U postgres -l | grep ship_

# Drop a specific worktree's database
psql -U postgres -c "DROP DATABASE ship_feature_123;"
```

## Troubleshooting

### Port Already in Use

If you see "Port already in use" errors:

```bash
# Check what's using the port
./scripts/check-ports.sh

# Or manually
lsof -i :3000
lsof -i :5173

# Kill the process
kill -9 <PID>
```

### Type Errors After Adding to Shared

If you add types to `shared` but API/Web can't see them:

```bash
# Rebuild shared package
pnpm run build:shared

# Restart your dev server
pnpm run dev
```

### Worktree Config Not Found

If `.env.local` files are missing:

```bash
# Re-run initialization
./scripts/worktree-init.sh

# Check status
./scripts/check-ports.sh
```

### Database Connection Failed

```bash
# Make sure PostgreSQL is running
pg_ctl status

# Check if database exists
psql -U postgres -l | grep ship_

# Recreate database
./scripts/worktree-init.sh
```

## Best Practices

1. **Always build shared first** - Run `pnpm run build:shared` after pulling changes
2. **Use workspace protocol** - Reference packages with `workspace:*`
3. **Never commit .env.local** - It's auto-generated per worktree
4. **Initialize each worktree** - Run `worktree-init.sh` after creating worktrees
5. **Use TypeScript project references** - Enables fast builds and IDE features
6. **Clean up old worktrees** - Delete worktrees and their databases when done

## Next Steps

- Add ESLint configuration for code quality
- Add Prettier for consistent formatting
- Set up Turborepo for build caching
- Add testing framework (Vitest/Jest)
- Configure CI/CD pipeline
- Add database migration tooling (Drizzle, Prisma)

## Resources

- pnpm Workspaces: https://pnpm.io/workspaces
- TypeScript Project References: https://www.typescriptlang.org/docs/handbook/project-references.html
- Vite Configuration: https://vitejs.dev/config/
- Express Best Practices: https://expressjs.com/en/advanced/best-practice-performance.html
- Git Worktree: https://git-scm.com/docs/git-worktree
