#!/bin/bash

echo "=== Worktree Status Check ==="
echo ""

# List all worktrees
echo "Active Git Worktrees:"
git worktree list
echo ""

# Check port usage
echo "Port Usage (API range 3000-4000):"
if command -v lsof &> /dev/null; then
  lsof -i :3000-4000 2>/dev/null | grep LISTEN | awk '{print $1, $2, $9}' || echo "  No ports in use"
else
  echo "  lsof not available"
fi
echo ""

echo "Port Usage (Web range 5173-6173):"
if command -v lsof &> /dev/null; then
  lsof -i :5173-6173 2>/dev/null | grep LISTEN | awk '{print $1, $2, $9}' || echo "  No ports in use"
else
  echo "  lsof not available"
fi
echo ""

# Check databases
if command -v psql &> /dev/null; then
  echo "Ship Databases:"
  psql -U postgres -lqt 2>/dev/null | cut -d \| -f 1 | grep "ship_" | sed 's/^/  /' || echo "  None found"
else
  echo "psql not available - cannot check databases"
fi
echo ""

# Check for .env.local files
echo "Worktree Configuration:"
for dir in api web; do
  if [ -f "$dir/.env.local" ]; then
    echo "  $dir/.env.local: ✓ exists"
    PORT=$(grep "^PORT=" "$dir/.env.local" 2>/dev/null | cut -d= -f2)
    VITE_PORT=$(grep "^VITE_PORT=" "$dir/.env.local" 2>/dev/null | cut -d= -f2)
    [ -n "$PORT" ] && echo "    API Port: $PORT"
    [ -n "$VITE_PORT" ] && echo "    Web Port: $VITE_PORT"
  else
    echo "  $dir/.env.local: ✗ missing (run ./scripts/worktree-init.sh)"
  fi
done
