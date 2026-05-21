> **Frozen 2026-05-21.** Point-in-time welcome guide. Not maintained. Mixes "sprint" and "week" vocabulary inconsistently — current canonical terminology lives in `docs/document-model-conventions.md` and `docs/week-documentation-philosophy.md`.

# Welcome to Ship

Ship is a project management platform designed for teams that ship software. It combines document collaboration, issue tracking, and sprint planning into a unified workspace where everything is a document.

---

## Core Philosophy

**Everything is a document.** Whether you're writing a wiki page, tracking an issue, planning a sprint, or defining a project—it's all the same underlying structure. This means:

- Consistent editing experience everywhere
- Real-time collaboration on any content
- Flexible organization without rigid hierarchies

---

## Understanding the Hierarchy

```
┌─────────────────────────────────────────────────────────────────┐
│                          PROGRAM                                │
│  (e.g., "Q1 2026 Initiatives")                                  │
│                                                                 │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │    PROJECT      │  │    PROJECT      │  │    PROJECT      │  │
│  │  "Auth System"  │  │  "Dashboard"    │  │  "Mobile App"   │  │
│  │                 │  │                 │  │                 │  │
│  │  ┌───────────┐  │  │  ┌───────────┐  │  │  ┌───────────┐  │  │
│  │  │  Issues   │  │  │  │  Issues   │  │  │  │  Issues   │  │  │
│  │  └───────────┘  │  │  └───────────┘  │  │  └───────────┘  │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                      SPRINTS                            │    │
│  │   Sprint 12 (done) → Sprint 13 (done) → Sprint 14 (now) │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

| Concept | Purpose | Contains |
|---------|---------|----------|
| **Program** | High-level initiative or team | Projects + Weeks |
| **Project** | Focused body of work with a goal | Issues + Documentation |
| **Week** | 7-day accountability window (inferred time period) | Issues worked on during that week |
| **Issue** | Single unit of work | Description, status, assignee |

---

## The Interface

Ship uses a **4-panel layout** that stays consistent across all document types:

```
┌────────┬──────────────┬─────────────────────────────┬────────────┐
│        │              │                             │            │
│  Rail  │   Sidebar    │       Main Editor           │ Properties │
│  48px  │   224px      │        (flex)               │   256px    │
│        │              │                             │            │
│ ┌────┐ │ ┌──────────┐ │  ┌───────────────────────┐  │ Status     │
│ │ 📄 │ │ │ Docs     │ │  │                       │  │ ──────     │
│ ├────┤ │ │ ├─ Wiki  │ │  │   Document Title      │  │ Priority   │
│ │ 📋 │ │ │ └─ Notes │ │  │                       │  │ ──────     │
│ ├────┤ │ ├──────────┤ │  │   Your content here   │  │ Assignee   │
│ │ 📁 │ │ │ Projects │ │  │   with real-time      │  │ ──────     │
│ ├────┤ │ │ ├─ Auth  │ │  │   collaboration...    │  │ Sprint     │
│ │ 🏃 │ │ │ └─ API   │ │  │                       │  │ ──────     │
│ └────┘ │ └──────────┘ │  └───────────────────────┘  │ Tags       │
│        │              │                             │            │
└────────┴──────────────┴─────────────────────────────┴────────────┘
   Icons    Context List        Rich Text Editor        Metadata
```

- **Rail**: Quick navigation between modes (Docs, Issues, Projects, Sprints)
- **Sidebar**: List of items in the current mode
- **Main Editor**: Rich text editing with real-time collaboration
- **Properties**: Metadata specific to the document type

---

## Getting Started

### Step 1: Create a Program

Programs are the top-level container. Create one for your team or initiative.

1. Click **Programs** in the rail
2. Click **+ New Program**
3. Give it a name (e.g., "Product Development Q1")
4. Add a description of the program's goals

### Step 2: Create Projects

Projects represent focused bodies of work within your program.

1. Open your program
2. Go to the **Projects** tab
3. Click **+ New Project**
4. Define:
   - **Title**: Clear, specific name
   - **Hypothesis**: What you believe this will achieve
   - **Success Criteria**: How you'll know it worked

```
┌─────────────────────────────────────────────────────┐
│  Project: User Authentication System                │
├─────────────────────────────────────────────────────┤
│                                                     │
│  Hypothesis:                                        │
│  "Adding SSO will reduce login friction and         │
│   increase daily active users by 15%"               │
│                                                     │
│  Success Criteria:                                  │
│  ☐ SSO integration with Okta complete               │
│  ☐ Login time reduced from 30s to 5s                │
│  ☐ Support tickets for login issues drop 50%        │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### Step 3: Add Issues

Issues are individual units of work. They can belong to projects and be associated with weeks.

1. Open a project
2. Go to the **Issues** tab
3. Click **+ New Issue**
4. Set priority, assignee, and tags

**Issue States:**

```
┌────────┐     ┌─────────┐     ┌──────┐     ┌─────────────┐     ┌───────────┐     ┌──────┐
│ triage │ ──▶ │ backlog │ ──▶ │ todo │ ──▶ │ in_progress │ ──▶ │ in_review │ ──▶ │ done │
└────────┘     └─────────┘     └──────┘     └─────────────┘     └───────────┘     └──────┘
(external       (internal
 feedback)      issues)        Any state can transition to cancelled:
                               ┌───────────┐
                               │ cancelled │
                               └───────────┘
```

- **Triage**: External feedback submissions awaiting review
- **Backlog**: Accepted ideas and future work, not yet prioritized
- **Todo**: Prioritized and ready to pick up
- **In Progress**: Someone is actively working on this
- **In Review**: Work complete, awaiting review/approval
- **Done**: Work is complete and approved
- **Cancelled**: Work deprioritized or no longer needed

---

## Sprint Planning

Sprints are time-boxed periods where your team commits to completing specific work.

### The Sprint Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   PLANNING          ACTIVE              REVIEW                  │
│   ─────────        ────────            ────────                 │
│                                                                 │
│   ┌─────────┐      ┌─────────┐        ┌─────────┐              │
│   │ Select  │      │  Work   │        │ Review  │              │
│   │ Issues  │ ──▶  │   &     │  ──▶   │   &     │              │
│   │ & Plan  │      │ Track   │        │ Retro   │              │
│   └─────────┘      └─────────┘        └─────────┘              │
│                                                                 │
│   Owner: PM        Owner: Team         Owner: PM + Team         │
│   Duration: 1 day  Duration: 1-2 wks   Duration: 1 day          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Creating a Sprint

1. Open your program
2. Go to the **Sprints** tab
3. Click **+ New Sprint**
4. Set:
   - **Sprint Number**: Auto-incremented
   - **Date Range**: Start and end dates
   - **Owner**: Who's responsible for this sprint

### Adding Issues to a Sprint

**Option A: From the Sprint**
1. Open the sprint
2. Go to the **Plan** tab
3. Click **Add from Backlog**
4. Select issues with checkboxes
5. Click **Add to Sprint**

```
┌─────────────────────────────────────────────┐
│  Add Issues to Sprint 14                    │
├─────────────────────────────────────────────┤
│  🔍 Search issues...                        │
├─────────────────────────────────────────────┤
│  ☑ #42 - Fix login bug           [High]    │
│  ☑ #43 - Add CSV export          [Medium]  │
│  ☐ #44 - Already in sprint       [Grey]    │
│  ☑ #45 - Refactor auth           [Low]     │
├─────────────────────────────────────────────┤
│  [Cancel]              [Add 3 Issues]       │
└─────────────────────────────────────────────┘
```

**Option B: From an Issue**
1. Open any issue
2. In the Properties panel, find **Sprint**
3. Select the target sprint from the dropdown

### Sprint Tabs

Each sprint has four tabs:

| Tab | Purpose |
|-----|---------|
| **Overview** | Sprint description, goals, and notes |
| **Plan** | Issue list with filters and bulk actions |
| **Review** | End-of-sprint review and hypothesis validation |
| **Standups** | Daily standup updates from the team |

### Running a Sprint

**Daily:**
- Team members post standups (Yesterday / Today / Blockers)
- Move issues through states as work progresses

**Weekly:**
- Check sprint burndown
- Address blockers in team sync

**End of Sprint:**
1. Go to **Review** tab
2. Document what was completed
3. Validate or invalidate the hypothesis
4. Reconcile incomplete issues (carry over or cancel)

---

## Sprint Owner & Availability

When assigning a sprint owner, Ship shows their current workload:

```
┌─────────────────────────────────┐
│  Sprint Owner                   │
├─────────────────────────────────┤
│  ▼ Select owner...              │
│  ┌─────────────────────────────┐│
│  │ 👤 Alice Chen    Available  ││
│  │ 👤 Bob Smith     2 sprints  ││
│  │ 👤 Carol Jones   1 sprint   ││
│  │ 👤 Dan Lee       Available  ││
│  └─────────────────────────────┘│
└─────────────────────────────────┘
```

- **Available**: No active sprints assigned
- **N sprint(s)**: Currently owns N active sprints

---

## Issue Management

### Multi-Association

Issues can belong to multiple contexts simultaneously:

```
┌──────────────────────────────────────────────────────────┐
│  Issue #42: "Add SSO Support"                            │
│                                                          │
│  belongs_to:                                             │
│    ├── Project: "Auth System"                            │
│    └── Week: "Week 14"                                   │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

This enables:
- Viewing issues by project OR by week
- Flexible organization without duplication
- Issues as trailing indicators of what was done during a week

### Bulk Operations

Select multiple issues with checkboxes to:
- Change status (e.g., mark all as done)
- Associate with week
- Change priority
- Add/remove tags

All bulk operations support **Undo** for 5 seconds.

### Filters

Filter issues by:
- **Status**: Triage, Backlog, Todo, In Progress, In Review, Done, Cancelled
- **Priority**: Urgent, High, Medium, Low, None
- **Assignee**: Team member
- **Week**: Current, specific, or none
- **Tags**: Custom labels

Filters sync to the URL, making them shareable.

---

## Standups

Keep your team aligned with daily standups.

### Posting a Standup

1. Open the current sprint
2. Go to **Standups** tab
3. Click **+ Add Standup**
4. Fill in:
   - **Yesterday**: What you completed
   - **Today**: What you're working on
   - **Blockers**: Anything preventing progress

### Viewing Standups

Standups appear in a timeline view, grouped by date:

```
┌─────────────────────────────────────────────────────────┐
│  January 22, 2026                                       │
├─────────────────────────────────────────────────────────┤
│  👤 Alice Chen                              9:15 AM     │
│  ┌─────────────────────────────────────────────────┐    │
│  │ Yesterday: Completed SSO integration tests      │    │
│  │ Today: Working on login UI updates              │    │
│  │ Blockers: None                                  │    │
│  └─────────────────────────────────────────────────┘    │
│                                                         │
│  👤 Bob Smith                               9:32 AM     │
│  ┌─────────────────────────────────────────────────┐    │
│  │ Yesterday: Fixed database migration issue       │    │
│  │ Today: Code review for PR #142                  │    │
│  │ Blockers: Waiting on design specs for modal     │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

---

## Sprint Reviews & Retrospectives

### Sprint Review

At the end of each sprint, document outcomes:

1. **What was completed?** - List of done issues
2. **What wasn't completed?** - Issues carrying over
3. **Hypothesis validation** - Was the sprint goal achieved?

```
┌─────────────────────────────────────────────────────────┐
│  Sprint 14 Review                                       │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Hypothesis: "Shipping SSO will reduce support tickets" │
│                                                         │
│  Result:  ✅ VALIDATED  /  ❌ INVALIDATED               │
│           ───────────                                   │
│                                                         │
│  Evidence:                                              │
│  - SSO shipped on Jan 20                                │
│  - Support tickets down 45% (target was 50%)           │
│  - User feedback positive                               │
│                                                         │
│  Learnings:                                             │
│  - SSO setup wizard needed more documentation           │
│  - Should have included password reset flow             │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Project Retrospectives

At the end of a project, capture comprehensive learnings:

1. Open the project
2. Go to **Retro** tab
3. Document:
   - What went well
   - What could improve
   - Action items for next time

---

## Claude Code Integration

Ship integrates with Claude Code for AI-assisted project management.

### Available Commands

Run these commands in Claude Code when working on a Ship-tracked project:

| Command | What it Does |
|---------|--------------|
| `/ship:status` | View current sprint progress and metrics |
| `/ship:standup` | Post a standup from your git activity |
| `/ship:issue` | Create an issue linked to your project |
| `/ship:review` | Start a sprint review with pre-filled data |
| `/ship:wiki` | Create or update a wiki document |
| `/ship:retro` | Guide a project retrospective |

### Automated Workflow

When using `/work` to execute a PRD, Ship automatically tracks progress:

```
┌────────────────────────────────────────────────────────────────┐
│                     /work Execution Flow                       │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  PRD File                    Ship Issues                       │
│  ─────────                   ───────────                       │
│                                                                │
│  userStories: [              ┌─────────┐                       │
│    {                         │  todo   │                       │
│      id: "story-1",    ───▶  └────┬────┘                       │
│      title: "Add login"           │                            │
│    }                              │ Claude picks story         │
│  ]                                ▼                            │
│                              ┌─────────────┐                   │
│                              │ in_progress │                   │
│                              └──────┬──────┘                   │
│                                     │                          │
│                                     │ Implementation done      │
│                                     │ Verification passed      │
│                                     ▼                          │
│                              ┌───────────┐                     │
│                              │ in_review │                     │
│                              └─────┬─────┘                     │
│                                    │                           │
│                                    │ Human approves            │
│                                    ▼                           │
│                              ┌──────────┐                      │
│                              │   done   │                      │
│                              └──────────┘                      │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `⌘ + K` | Quick search |
| `⌘ + N` | New document (context-aware) |
| `⌘ + S` | Save (auto-saved, but forces sync) |
| `⌘ + /` | Toggle sidebar |
| `Esc` | Close modal / deselect |

---

## Tips for Success

### 1. Keep Issues Small
Break work into issues that can be completed in 1-2 days. Large issues hide complexity and slow down progress tracking.

### 2. Write Clear Hypotheses
Every project should have a testable hypothesis. "Make it better" isn't a hypothesis. "Reducing checkout steps from 5 to 3 will increase conversion by 10%" is.

### 3. Use Standups Consistently
Even a brief standup keeps the team aligned. Blockers discovered early are blockers resolved quickly.

### 4. Review Sprints Honestly
Mark hypotheses as invalidated when the evidence doesn't support them. Failed experiments are still valuable learning.

### 5. Link Issues to Commits
Reference issue numbers in commit messages (e.g., "Fix login timeout #42"). This creates traceability from code to planning.

---

## Getting Help

- **In-app**: Click the `?` icon in the bottom-left corner
- **Documentation**: Check the Docs section in Ship
- **Claude Code**: Run `/ship:help` for command reference

---

*Welcome aboard. Let's ship something great.*
