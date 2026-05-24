> **Frozen 2026-01-22.** Point-in-time 72-hour changelog. Not maintained. Some references (e.g., `project_id`/`sprint_id` columns, `sprint_plan`/`sprint_retro` types) reflect state before migrations 027, 029, 032, and 033.

# Ship Platform Changes - January 20-22, 2026

This document summarizes all significant changes to the Ship platform and Claude/Ship integration over the past 72 hours.

## Executive Summary

| Metric | Count |
|--------|-------|
| PRDs Completed | 4 |
| PRDs In Progress | 1 |
| User Stories Delivered | 41+ |
| Git Commits | 85+ |
| Major Features | 7 |

---

## Completed PRDs

### 1. Unified Document Routing (12/12 stories)
**Impact:** Major architectural change unifying all document access patterns

All document types now use `/documents/:id` as the canonical route:
- `/docs/:id`, `/projects/:id`, `/programs/:id`, `/sprints/:id` redirect to `/documents/:id`
- Rail highlighting based on `document_type` field, not URL
- Sidebar shows type-appropriate list for each document
- Sprint tabs: Overview, Plan, Review, Standups
- Back navigation returns to correct list page (e.g., project → /projects)
- Removed 5 legacy page components (cleaner codebase)

### 2. Reusable Issues List Component (15/15 stories)
**Impact:** Standardized issue management across all contexts

- Extracted reusable `IssuesList` component with bulk actions
- Checkbox selection persists across navigation
- Undo support for bulk operations (5-second window)
- URL-synced filters with namespaced query params
- Context inheritance (new issues auto-linked to project/sprint)
- Deprecated legacy `project_id`/`sprint_id` fields in favor of `belongs_to[]` array

### 3. Document Tab Deep Linking (5/5 stories)
**Impact:** Shareable URLs for specific document tabs

- URL-driven tab state (`/documents/:id/:tab`)
- Configuration-based tab registry by document type
- Invalid tab redirects to clean URL
- Sprint planning tabs accessible via URL

### 4. Project-Centric Sprint Planning (12/12 stories)
**Impact:** Improved sprint workflow

- Sprint review entry points with badges
- Historical week picker for My Week view
- Sprint close reconciliation prompts
- In-app standup due indicators
- Guided project creation wizard

### 5. Sprint Workflow Enhancement (in progress)
**Impact:** Streamlined sprint management with bulk operations and owner tracking

**Branch:** `feat/sprint-workflow-enhancement`

#### Sprint Owner with Availability Tracking
- Owner dropdown in sprint properties sidebar
- Availability indicators per person ("Available" vs "2 sprint(s)")
- Calculates active sprint count per owner in real-time
- Uses `user_id` for accurate availability comparison

#### Backlog Picker Modal
New bulk selection interface for adding issues to sprints:
```
┌─────────────────────────────────────────────┐
│  Add Issues to Sprint 14                    │
├─────────────────────────────────────────────┤
│  🔍 Search issues...                        │
├─────────────────────────────────────────────┤
│  ☑ Issue #42 - Fix login bug     [High]    │
│  ☑ Issue #43 - Add export        [Medium]  │
│  ☐ Issue #44 - Already in sprint [Greyed]  │
│  ☑ Issue #45 - Refactor auth     [Low]     │
├─────────────────────────────────────────────┤
│  [Cancel]              [Add 3 Issues]       │
└─────────────────────────────────────────────┘
```

Features:
- Checkbox multi-select with search
- Already-assigned issues greyed out
- Batch PATCH for all selected issues
- Works for sprint, project, or program context

#### Context-Aware Issue Creation
- Inline "+" button creates issues pre-linked to current sprint/project
- `inheritedContext` prop flows through IssuesList component
- New issues auto-populate `belongs_to[]` with current context

#### Standardized Sprint Issues List
- Replaced custom issues table with reusable `IssuesList` component
- List/Kanban toggle (list is default per interview decision)
- Self-fetching via `lockedSprintId` prop
- Consistent UX across all issue contexts

#### API Fixes
- `sync sprint owner to assignee_ids array` - Owner selection persists correctly
- `align sprint status field name` - Consistent `sprint_status` vs `status` handling
- Sprint creation includes `document_association` and correct route path
- Hide "Create Sprint" option on project sprints tab (sprints belong to programs)

#### Files Changed (15 files, +972/-275 lines)
| File | Changes |
|------|---------|
| `BacklogPickerModal.tsx` | NEW - 359 lines |
| `IssuesList.tsx` | +175 lines (inline creation, backlog picker integration) |
| `SprintSidebar.tsx` | +66 lines (owner dropdown, availability) |
| `SprintDetailView.tsx` | Refactored to use IssuesList |
| `ProgramSprintsTab.tsx` | Simplified (-108 lines) |
| `documents.ts` (API) | +66 lines (sprint status, associations) |

---

## Claude/Ship Integration Enhancements

### Ship Skill Commands

| Command | Purpose |
|---------|---------|
| `/ship:status` | Sprint dashboard with progress metrics |
| `/ship:standup` | AI-assisted standup posting from git activity |
| `/ship:issue` | Create issues with context awareness |
| `/ship:review` | Sprint review with pre-fill from Ship data |
| `/ship:wiki` | Create/update wiki pages |
| `/ship:retro` | Project retrospective guidance |
| `/ship:auth` | Authenticate Claude Code with Ship API |

**Command Details:**

- **`/ship:status`** - Fetches current sprint, calculates velocity metrics, shows issues by state (todo/in_progress/in_review/done), displays recent standups. Useful for daily check-ins.

- **`/ship:standup`** - Analyzes `git log` since last standup, correlates commits to issues, drafts intelligent standup update with "Yesterday/Today/Blockers" format, posts to current sprint.

- **`/ship:issue`** - Creates issues with automatic context inheritance. If invoked from a project directory with `ship_project_id` in PRD, auto-links to that project. Supports priority, tags, and assignment.

- **`/ship:review`** - Pre-fills sprint review from Ship data: completed issues, velocity stats, hypothesis validation status. Human edits and submits.

- **`/ship:wiki`** - Creates or updates wiki documents in Ship. Converts markdown to TipTap JSON format. Useful for documentation, changelogs, and decision records.

---

### The /work Workflow (PRD Execution Loop)

The `/work` command executes PRDs using an enforced validation loop. It runs until ALL user stories pass, then performs post-completion tasks.

#### PRD Structure with Ship Integration

```json
{
  "name": "feature-name",
  "ship_project_id": "uuid-of-ship-project",
  "ship_issue_ids": {
    "story-1-id": "ship-issue-uuid-1",
    "story-2-id": "ship-issue-uuid-2"
  },
  "confidence": 70,
  "userStories": [...],
  "feedbackLoops": {
    "type_check": "pnpm type-check",
    "test": "pnpm test",
    "build": "pnpm build"
  }
}
```

#### Execution Phases

**Phase 1: Initialization**
1. Locate PRD file in `plans/` directory
2. Create/resume progress file (`{name}-progress.txt`)
3. Setup ralph loop (stop hook prevents exit until complete)
4. Check Ship connection and replay any queued operations
5. Display status: X/Y stories passing

**Phase 2: Iteration Loop** (repeats until all stories pass)

```
┌─────────────────────────────────────────────────────────┐
│  2.1 Get Bearings                                       │
│      - Read git log, progress file, story status        │
│                                                         │
│  2.2 Pick Next Story                                    │
│      - Highest priority with passes=false               │
│      - Update Ship issue → in_progress                  │
│      - Initialize confidence from PRD                   │
│                                                         │
│  2.3 Implement ONE Story                                │
│      - Small, focused changes                           │
│      - Follow existing patterns                         │
│                                                         │
│  2.4 Run Feedback Loops                                 │
│      - type_check, test, build (all must pass)          │
│      - Fix issues, re-run until green                   │
│                                                         │
│  2.5 Verify End-to-End                                  │
│      - Browser testing via Playwright MCP               │
│      - API testing via curl                             │
│      - On failure: log to Ship, decrease confidence     │
│                                                         │
│  2.6 Update PRD                                         │
│      - Set story passes=true                            │
│      - Update Ship issue → in_review                    │
│      - Send telemetry (iterations, confidence)          │
│                                                         │
│  2.7 Log & Commit                                       │
│      - Append to progress file                          │
│      - Git commit with story reference                  │
│                                                         │
│  2.8 Check Exit Condition                               │
│      - All stories pass? → Phase 3                      │
│      - Otherwise → Loop back to 2.1                     │
└─────────────────────────────────────────────────────────┘
```

**Phase 3: Post-Completion** (enforced by stop hook)

| Check | Required | Condition |
|-------|----------|-----------|
| Security Review | Always | Run security-sentinel agent |
| Tests Added | Always | Lock-the-door tests for new code |
| Critical Findings | Always | Must be empty array |
| Seed Data | If schema changed | Run db:seed |
| Fixtures Updated | If schema changed | Validate factories |

Exit blocked until all criteria pass.

#### Ship Issue State Transitions

```
┌──────────┐     Story      ┌─────────────┐    Verified    ┌───────────┐
│   todo   │ ──────────────▶│ in_progress │ ──────────────▶│ in_review │
└──────────┘     Picked     └─────────────┘                └───────────┘
                                                                  │
                                                                  │ Human
                                                                  │ Approves
                                                                  ▼
                                                            ┌──────────┐
                                                            │   done   │
                                                            └──────────┘
```

**Philosophy:** Claude completes implementation and moves to `in_review`. Human developer validates and approves before `done`. This ensures quality control and human oversight.

#### Telemetry Captured Per Story

```json
{
  "iterations": 3,
  "feedback_loops": {
    "type_check": 5,
    "test": 4,
    "build": 2
  },
  "time_elapsed_seconds": 1847,
  "files_changed": ["src/components/Foo.tsx", "src/lib/bar.ts"],
  "confidence": 80
}
```

#### Confidence Tracking

- **Initial:** From PRD `confidence` field (default: 70)
- **On verification failure:** -10 (minimum 0)
- **On story success:** +10 (maximum 100)
- **Stored:** In Ship issue `claude_metadata.confidence`
- **Aggregated:** Project-level confidence updated after each story

#### Blocker Issue Creation

When verification fails and a blocker is identified:
1. Claude asks: "Create blocker issue in Ship?"
2. If yes: Creates issue with `blocker` tag, high priority
3. Links to project via `belongs_to[]`
4. Blocker appears in sprint planning view

---

### Offline Queue Support

Ship API calls are queued when the connection fails:

```
~/.claude/ship-queue.jsonl
```

**Queued Operations:**
- `update_issue_state` - State transitions (in_progress, in_review)
- `create_issue_iteration` - Iteration logs
- `log_verification_failure` - Failed verification attempts
- `update_project_confidence` - Confidence updates
- `create_blocker` - Blocker issue creation

**Queue Replay:**
- Automatic on `/work` initialization if Ship is reachable
- Manual via `ship_queue_replay` function
- Preserves order and prevents data loss

---

### Progress File Format

Each PRD has a companion progress file (`{name}-progress.txt`):

```markdown
# Progress Log
PRD: plans/feature-name.prd.json
Started: 2026-01-21T10:00:00Z

---

## Iteration 1 - story-title
- Completed: Implemented X feature
- Files changed: src/A.tsx, src/B.ts
- Learnings: Found pattern Y useful
- Next: story-2-title

## Iteration 2 - story-2-title
...
```

**Purpose:**
- Survives context compaction (Claude re-reads on resume)
- Audit trail of implementation decisions
- Learnings extraction for future PRDs

---

## API & Backend Changes

### Performance Improvements
- Fixed N+1 queries in issues endpoint
- Fixed N+1 query in standups `transformIssueLinks`
- Configured PostgreSQL connection pooling for production

### New Endpoints
- `POST /api/sprints/:id/start` - Start a planning sprint
- Sprint review pre-fill with issues data
- Issue-level iteration tracking

### Bug Fixes
- Case-insensitive email matching in invite acceptance
- PIV login duplicate person document prevention
- Yjs WebSocket provider cleanup race condition
- AbortSignal support for file uploads (cancellation)
- Circular reference protection for `parent_id`

### Testing
- 34 session timeout test cases
- WebSocket collaboration tests
- Comprehensive API route tests (auth, issues, sprints)
- Lock-the-door tests for selection persistence

---

## Infrastructure

### WAF & Security
- Terraform-managed WAF rules
- CloudFront logging enabled
- AWSManagedRulesAntiDDoSRuleSet integration

### Deployment
- Shadow environment support for UAT
- Auto-run terraform apply if S3 bucket not found
- Environment-specific terraform files gitignored

---

## UI/UX Improvements

- Scroll breathing room on all scrollable containers
- Drag-and-drop for non-image file attachments
- Auto-focus title input on new documents
- Allocation page header transparency fix
- In-place document type conversion with undo

---

## Data Model Evolution

### Multi-Association Architecture
Issues now support multiple associations via `belongs_to[]` array:
```json
{
  "belongs_to": [
    {"id": "project-uuid", "type": "project"},
    {"id": "sprint-uuid", "type": "sprint"}
  ]
}
```

Benefits:
- Issues can belong to multiple sprints (carry-over support)
- Sub-issues with unlimited depth
- Cleaner API for association management

### Deprecated Fields
- `project_id` → Use `belongs_to[]` with type: "project"
- `sprint_id` → Use `belongs_to[]` with type: "sprint"

---

## Security Review Notes

All changes passed security review:
- Routes properly authenticated via `ProtectedRoute`
- Authorization checks via `canAccessDocument()`
- CSRF protection on state-changing operations
- Parameterized SQL queries (no injection vulnerabilities)
- No hardcoded secrets

---

## Known Issues

1. **Pre-existing test failure**: `sprint-reviews.test.ts` - Test expects issues in pre-fill but test setup doesn't link issues correctly. Unrelated to new changes.

---

## What's Next

- **My Work Dashboard PRD**: 10 stories planned (personal task aggregation)
- Shadow deployment for UAT before merge to production
- E2E test coverage for new routing patterns

---

*Generated: January 22, 2026*
*PRD: unified-document-routing*
