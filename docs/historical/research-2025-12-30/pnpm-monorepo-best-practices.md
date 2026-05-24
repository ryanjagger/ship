# pnpm Monorepo Best Practices Research
**Date:** 2025-12-30
**Focus:** Express API + React/Vite + Shared Types with Worktree Isolation

## Sources
- Official pnpm documentation: https://pnpm.io/workspaces
- Vercel Turborepo examples (pnpm-based)
- Popular GitHub repositories with pnpm monorepos
- Industry patterns for concurrent development

---

## 1. Workspace Configuration (pnpm-workspace.yaml)

### Official Recommendation (pnpm.io)
The `pnpm-workspace.yaml` file must exist in the repository root and defines which directories contain packages.

**Best Practice Pattern:**
```yaml
packages:
  - 'api'
  - 'web'
  - 'shared'
  # Or use wildcards for scalability:
  # - 'apps/*'
  # - 'packages/*'
```

**Key Points:**
- Keep it simple - explicit paths for small monorepos
- Use wildcards (`apps/*`, `packages/*`) for larger repos with many packages
- Each directory listed should have its own `package.json`

---

## 2. Shared TypeScript Types

### Pattern: Dedicated Shared Package
The recommended approach is to create a `shared` package that exports types, constants, and utilities.

**Structure:**
```
shared/
├── package.json
├── tsconfig.json
├── src/
│   ├── types/
│   │   ├── index.ts      # Re-export all types
│   │   ├── user.ts
│   │   └── api.ts
│   └── index.ts          # Main entry point
└── dist/                 # Built output
```

**shared/package.json:**
```json
{
  "name": "@ship/shared",
  "version": "0.0.0",
  "private": true,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch"
  },
  "devDependencies": {
    "typescript": "^5.7.2"
  }
}
```

**Consuming in api/web:**
```json
{
  "dependencies": {
    "@ship/shared": "workspace:*"
  }
}
```

The `workspace:*` protocol tells pnpm to link the local package.

---

## 3. TypeScript Configuration

### Pattern: Shared Base Config + Package Overrides

**Root tsconfig.json (base):**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

**api/tsconfig.json:**
```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "references": [
    { "path": "../shared" }
  ]
}
```

**web/tsconfig.json:**
```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "outDir": "./dist"
  },
  "include": ["src"],
  "references": [
    { "path": "../shared" }
  ]
}
```

**Key Concept: Project References**
TypeScript's project references (`references` field) enable:
- Fast incremental builds
- Type checking across packages
- IDE support for "Go to Definition" across packages

---

## 4. Development Scripts (Concurrent Execution)

### Pattern: Root-level dev script with concurrently

**Root package.json:**
```json
{
  "scripts": {
    "dev": "pnpm --parallel --recursive run dev",
    "dev:api": "pnpm --filter @ship/api dev",
    "dev:web": "pnpm --filter @ship/web dev",
    "build": "pnpm --recursive run build",
    "build:shared": "pnpm --filter @ship/shared build"
  },
  "devDependencies": {
    "concurrently": "^8.2.2"
  }
}
```

**Alternative: Using turbo (recommended for larger repos):**
```json
{
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build"
  }
}
```

**pnpm Built-in Options:**
- `--recursive` - Run in all workspace packages
- `--parallel` - Run in parallel (don't wait for each to finish)
- `--filter <package>` - Run only in specific package
- `pnpm -r run dev` - Shorthand for recursive

---

## 5. Build and Deployment Patterns

### Pattern: Build Shared First, Then Apps

**Recommended Build Order:**
1. Build `shared` package first
2. Build `api` (depends on shared)
3. Build `web` (depends on shared)

**Using pnpm workspace protocol:**
```json
{
  "scripts": {
    "build": "pnpm -r --filter '@ship/shared' run build && pnpm -r --filter '{@ship/api,@ship/web}' run build"
  }
}
```

**Or with turbo (handles dependencies automatically):**
```json
// turbo.json
{
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    }
  }
}
```

### Deployment Strategy

**Option 1: Deploy API and Web Separately**
- Build entire monorepo
- Deploy `api/dist` to backend hosting (EB, Fargate, etc.)
- Deploy `web/dist` to static hosting (S3+CloudFront, Vercel, etc.)

**Option 2: Docker Multi-stage Build**
```dockerfile
# Build stage
FROM node:20 AS builder
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY api/package.json ./api/
COPY web/package.json ./web/
COPY shared/package.json ./shared/
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build

# API stage
FROM node:20-slim AS api
WORKDIR /app
COPY --from=builder /app/api/dist ./dist
COPY --from=builder /app/api/package.json ./
CMD ["node", "dist/index.js"]
```

---

## 6. Worktree Isolation (KEY REQUIREMENT)

### Problem Statement
When running multiple git worktrees simultaneously, conflicts occur:
- Port collisions (both API and Web dev servers)
- Database conflicts (same database name, migrations clash)
- Process conflicts (PID files, lock files)

### Solution: Environment-based Configuration

**Pattern 1: Auto-detect Worktree and Configure Ports**

**Root script: scripts/worktree-init.sh**
```bash
#!/bin/bash
# Generate unique configuration per worktree

WORKTREE_PATH=$(git rev-parse --show-toplevel)
WORKTREE_NAME=$(basename "$WORKTREE_PATH")
BRANCH_NAME=$(git branch --show-current)

# Generate unique port offsets based on hash of worktree path
HASH=$(echo -n "$WORKTREE_PATH" | md5sum | cut -c1-4)
PORT_OFFSET=$((0x$HASH % 1000))

API_PORT=$((3000 + PORT_OFFSET))
WEB_PORT=$((5173 + PORT_OFFSET))
DB_NAME="ship_${BRANCH_NAME//-/_}"

# Create .env.local files
cat > api/.env.local << EOF
PORT=$API_PORT
DATABASE_URL=postgresql://localhost:5432/$DB_NAME
NODE_ENV=development
EOF

cat > web/.env.local << EOF
VITE_API_URL=http://localhost:$API_PORT
VITE_PORT=$WEB_PORT
EOF

echo "Worktree initialized:"
echo "  API Port: $API_PORT"
echo "  Web Port: $WEB_PORT"
echo "  Database: $DB_NAME"
```

**Usage:**
```bash
# After creating a new worktree:
git worktree add ../ship-feature-123 feature-123
cd ../ship-feature-123
./scripts/worktree-init.sh
pnpm install
pnpm run dev
```

**Pattern 2: .env.template Files**

**api/.env.template:**
```env
PORT=3000
DATABASE_URL=postgresql://localhost:5432/ship_main
NODE_ENV=development
LOG_LEVEL=debug
```

**web/.env.template:**
```env
VITE_API_URL=http://localhost:3000
VITE_PORT=5173
```

**In .gitignore:**
```
.env.local
.env.*.local
```

**Pattern 3: Database Per Worktree**

**api/src/config/database.ts:**
```typescript
import { config } from 'dotenv';
import { join } from 'path';

// Load .env.local if exists, fallback to .env
config({ path: join(__dirname, '../../.env.local') });
config({ path: join(__dirname, '../../.env') });

// Auto-generate DB name from branch if not set
const branch = process.env.GIT_BRANCH ||
  require('child_process')
    .execSync('git branch --show-current')
    .toString()
    .trim();

const dbName = process.env.DATABASE_NAME ||
  `ship_${branch.replace(/[^a-zA-Z0-9]/g, '_')}`;

export const databaseConfig = {
  url: process.env.DATABASE_URL?.replace('ship_main', dbName) ||
    `postgresql://localhost:5432/${dbName}`,
};
```

**Migration Script per Worktree:**
```bash
# package.json
{
  "scripts": {
    "db:create": "node scripts/create-db.js",
    "db:migrate": "npm run db:create && drizzle-kit migrate",
    "dev": "npm run db:migrate && tsx watch src/index.ts"
  }
}
```

**scripts/create-db.js:**
```javascript
const { execSync } = require('child_process');
const { databaseConfig } = require('../dist/config/database');

// Extract DB name from connection string
const dbName = new URL(databaseConfig.url).pathname.slice(1);

try {
  execSync(`psql -U postgres -tc "SELECT 1 FROM pg_database WHERE datname = '${dbName}'" | grep -q 1 || psql -U postgres -c "CREATE DATABASE ${dbName}"`);
  console.log(`Database '${dbName}' ready`);
} catch (error) {
  console.error('Database creation failed:', error.message);
  process.exit(1);
}
```

### Verification Script

**scripts/check-ports.sh:**
```bash
#!/bin/bash
# Check what's running where

echo "Active worktrees:"
git worktree list

echo -e "\nPort usage:"
lsof -i :3000-4000 2>/dev/null | grep LISTEN || echo "No ports in use (3000-4000)"
lsof -i :5173-6173 2>/dev/null | grep LISTEN || echo "No ports in use (5173-6173)"

echo -e "\nDatabases:"
psql -U postgres -c "\l" | grep ship_ || echo "No ship databases found"
```

---

## Summary: Complete Setup Checklist

- [ ] Create `pnpm-workspace.yaml` in root
- [ ] Set up `shared` package with TypeScript types
- [ ] Configure tsconfig with project references
- [ ] Add `workspace:*` dependencies in consuming packages
- [ ] Create `.env.template` files (checked in)
- [ ] Add `.env.local` to `.gitignore`
- [ ] Create `scripts/worktree-init.sh` for auto-configuration
- [ ] Configure API to use dynamic port/database
- [ ] Configure Web dev server to use dynamic port
- [ ] Test: Create two worktrees, run both simultaneously
- [ ] Add verification scripts for port/database status

---

## Additional Tools (Optional but Recommended)

**Turborepo:** Build orchestration and caching
- Automatically handles build dependencies
- Remote caching for CI/CD
- Parallel execution with dependency graph

**Changesets:** Version management and changelogs
- Semantic versioning for packages
- Automated changelog generation
- Works well with monorepos

**ESLint/Prettier:** Code quality and formatting
- Shared configs in root or `shared/eslint-config`
- Consistent across all packages

---

## Anti-Patterns to Avoid

1. **Don't use relative paths in imports** - Use package names (`@ship/shared`)
2. **Don't commit `.env.local`** - Always gitignore, use `.env.template`
3. **Don't hardcode ports** - Always use environment variables
4. **Don't share database between worktrees** - Each worktree needs isolation
5. **Don't forget to build `shared`** - Consumers need the compiled output
6. **Don't use `link-workspace-packages: false`** - Breaks workspace functionality

---

## Resources

- pnpm Workspaces: https://pnpm.io/workspaces
- TypeScript Project References: https://www.typescriptlang.org/docs/handbook/project-references.html
- Turborepo with pnpm: https://turbo.build/repo/docs/handbook/package-installation#pnpm
- Git Worktree: https://git-scm.com/docs/git-worktree
