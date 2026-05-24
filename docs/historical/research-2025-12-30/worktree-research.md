# Worktree Isolation Research

## Key Challenges for Concurrent Worktrees:
1. Port conflicts (API and Web dev servers)
2. Database isolation (migrations per worktree)
3. Environment variable separation
4. Process/PID file conflicts
5. Build artifact isolation

## Common Patterns Found:

### 1. Port Configuration
- Use environment variables for all ports
- Generate ports dynamically based on worktree path/hash
- Convention: BASE_PORT + WORKTREE_ID

### 2. Database Per Worktree
- Separate database per worktree (e.g., myapp_main, myapp_feature-123)
- Database name from git branch name
- Migration state isolated per database

### 3. Environment Variable Loading
- .env.local per worktree (gitignored)
- .env.template checked in
- Init script to generate .env.local with unique values

### 4. Process Isolation
- PID files in .worktree/ directory (gitignored)
- Named process IDs include worktree identifier
- Lock files isolated

### 5. Build Isolation
- node_modules shared (pnpm symlinks handle this)
- dist/ and build/ output separate per worktree
- Each worktree has own .pnpm store links
