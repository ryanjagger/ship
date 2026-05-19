#!/usr/bin/env bash
# Type-safety audit: counts violations across the Ship monorepo.
#
# Reproduces every number in audit/type-safety/README.md.
# Run from anywhere; paths are resolved relative to the repo root.
#
# Requires: ripgrep (rg)

set -euo pipefail

# Resolve repo root (this script lives in <repo>/audit/type-safety/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

if ! command -v rg >/dev/null 2>&1; then
  echo "error: ripgrep (rg) is required" >&2
  exit 1
fi

# Shared glob list: TS sources only, no declaration files.
# (rg also ignores node_modules/dist/build via .gitignore.)
GLOBS=(-g '*.ts' -g '*.tsx' -g '!*.d.ts')

PKGS=(api web shared e2e)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Sum per-file counts from `rg -c` (format: path:N) by summing the last field.
sum_rg_c() {
  awk -F: '{s+=$NF} END{print s+0}'
}

# Count occurrences of $1 across all packages and print one row per package.
# `rg -c` exits 1 when there are zero matches — swallow that, treat as 0.
count_per_pkg() {
  local label="$1"; local pat="$2"
  printf "  %-38s" "$label"
  local total=0
  for p in "${PKGS[@]}"; do
    local c
    c=$( { rg "${GLOBS[@]}" -c "$pat" "$p" 2>/dev/null || true; } | sum_rg_c )
    total=$((total + c))
    printf " %s=%-5s" "$p" "$c"
  done
  printf "  total=%s\n" "$total"
}

hr() { printf '%.0s-' {1..78}; echo; }

# ---------------------------------------------------------------------------
# Headline metrics (match the README "Audit Deliverable" table)
# ---------------------------------------------------------------------------

echo "Type Safety Audit — $(date +%Y-%m-%d)"
echo "Repo: $REPO_ROOT"
echo "Branch: $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'n/a')"
hr

echo "## Audit Deliverable"
echo

# 1. Total 'any' types — deduplicated across all type positions.
#    Matches `: any`, `as any`, `<any`, `,any`, `any[]`, `any|`, `any&`, `any>`.
ANY_TOTAL=$( { rg "${GLOBS[@]}" -o \
  '(?::\s*|\bas\s+|<|,\s*)any\b|\bany(\[\]|\s*[|&>])' \
  "${PKGS[@]}" 2>/dev/null || true; } | wc -l | tr -d ' ')
printf "  %-44s %s\n" "Total any types:" "$ANY_TOTAL"

# 2. Total TS type assertions — uppercase-first types OR TS primitive keywords.
#    Excludes SQL `AS alias` (lowercase identifiers inside template strings)
#    and `import { x as y }` aliases.
AS_TOTAL=$( { rg "${GLOBS[@]}" -o \
  '\bas\s+([A-Z][A-Za-z0-9_]*|string|number|boolean|any|unknown|never|void|null|undefined|object|symbol|bigint)\b' \
  "${PKGS[@]}" 2>/dev/null || true; } | wc -l | tr -d ' ')
printf "  %-44s %s\n" "Total type assertions (as):" "$AS_TOTAL"

# 3. Non-null assertions — identifier/bracket/paren followed by ! then . [ or ,
#    Heuristic; will miss `x!;` and `x!)` but those are uncommon.
NN_TOTAL=$( { rg "${GLOBS[@]}" -o \
  '[A-Za-z0-9_\)\]]!(\.|\[|,)' \
  "${PKGS[@]}" 2>/dev/null || true; } | wc -l | tr -d ' ')
printf "  %-44s %s\n" "Total non-null assertions (!):" "$NN_TOTAL"

# 4. @ts- directives.
TS_DIRECTIVES=$( { rg "${GLOBS[@]}" -c '@ts-(ignore|expect-error|nocheck)' \
  "${PKGS[@]}" 2>/dev/null || true; } | sum_rg_c)
printf "  %-44s %s\n" "Total @ts-ignore / @ts-expect-error:" "$TS_DIRECTIVES"

# 5. Strict mode.
STRICT_ROOT=$(rg -o '"strict"\s*:\s*true' tsconfig.json 2>/dev/null | head -1 || true)
STRICT_WEB=$(rg -o '"strict"\s*:\s*true' web/tsconfig.json 2>/dev/null | head -1 || true)
if [[ -n "$STRICT_ROOT" && -n "$STRICT_WEB" ]]; then
  STRICT="Yes (all packages)"
else
  STRICT="No / partial"
fi
printf "  %-44s %s\n" "Strict mode enabled?" "$STRICT"
printf "  %-44s %s\n" "Strict mode error count (if disabled):" "N/A"

echo
hr
echo "## Per-package breakdown"
echo

count_per_pkg "': any' annotation"           ': any\b'
count_per_pkg "'as any'"                     '\bas any\b'
count_per_pkg "'any[]'"                      '\bany\[\]'
count_per_pkg "'Record<string, any>'"        'Record<string, any>'
count_per_pkg "'as unknown'"                 '\bas unknown\b'
count_per_pkg "'as <UpperCaseType>'"         '\bas [A-Z][A-Za-z0-9_]*'
count_per_pkg "'as <primitive>'"             '\bas (string|number|boolean|never|void|null|undefined|object|symbol|bigint)\b'
count_per_pkg "'@ts-ignore'"                 '@ts-ignore'
count_per_pkg "'@ts-expect-error'"           '@ts-expect-error'
count_per_pkg "'@ts-nocheck'"                '@ts-nocheck'
count_per_pkg "non-null '!.', '![', '!,'"    '[A-Za-z0-9_\)\]]!(\.|\[|,)'

echo
hr
echo "## Top 5 violation-dense files"
echo

# Combined per-file count of: `: any` + `as any` + `as unknown`
# + non-null assertions + @ts-* directives.
violation_file_counts() {
  {
    rg "${GLOBS[@]}" -c ': any\b'                            "${PKGS[@]}" 2>/dev/null || true
    rg "${GLOBS[@]}" -c '\bas any\b'                         "${PKGS[@]}" 2>/dev/null || true
    rg "${GLOBS[@]}" -c '\bas unknown\b'                     "${PKGS[@]}" 2>/dev/null || true
    rg "${GLOBS[@]}" -c '[A-Za-z0-9_\)\]]!(\.|\[|,)'         "${PKGS[@]}" 2>/dev/null || true
    rg "${GLOBS[@]}" -c '@ts-(ignore|expect-error|nocheck)'  "${PKGS[@]}" 2>/dev/null || true
  } | awk -F: '{tot[$1]+=$2} END{for (f in tot) print tot[f]"\t"f}'
}

echo "All files (tests dominate):"
violation_file_counts | sort -rn | head -5 | awk '{printf "  %3d  %s\n", $1, $2}'

echo
echo "Production source only (test files excluded):"
violation_file_counts \
  | grep -vE '\.test\.(ts|tsx)|/__tests__/|/test/' \
  | sort -rn | head -5 | awk '{printf "  %3d  %s\n", $1, $2}'

echo
hr
echo "## Strict mode settings"
echo
echo "Root tsconfig.json:"
{ rg -n '"(strict|noUncheckedIndexedAccess|noImplicitReturns|noFallthroughCasesInSwitch)"' \
    tsconfig.json || true; } | sed 's/^/  /'
echo
echo "web/tsconfig.json:"
{ rg -n '"(strict|noUncheckedIndexedAccess|noImplicitReturns|noFallthroughCasesInSwitch)"' \
    web/tsconfig.json || true; } | sed 's/^/  /'
echo
echo "Gap: web/tsconfig.json does not extend root and is missing"
echo "noUncheckedIndexedAccess + noImplicitReturns."
