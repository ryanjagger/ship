# What's New: Accountability System

Ship now includes a comprehensive accountability system that helps teams stay on track with hypothesis-driven development. This update introduces automatic reminders, approval workflows, and visibility into team progress.

---

## Overview

The accountability system ensures teams follow Ship's core philosophy: write a hypothesis before you start, post standups during work, and review what you learned when you're done.

**Key additions:**
- Automatic reminders when you're behind on tasks
- RACI role assignments for clear ownership
- Admin approval workflow for hypotheses and reviews
- Real-time accountability grid for managers

---

## Action Items

When you log in, Ship now checks if you have outstanding accountability tasks and shows them immediately.

```
┌─────────────────────────────────────────────────────────────────┐
│  ⚠️  You have 3 items that need attention                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  📝 Post standup for Week of Jan 274 - Design System                  │
│     3 issues assigned · Due today                               │
│                                                                 │
│  💡 Write hypothesis for Week of Jan 275                              │
│     Week starts tomorrow · Due Jan 28                         │
│                                                                 │
│  📊 Complete review for Week of Jan 273                               │
│     1 day overdue · Due Jan 26                                  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Action Item Types

| Type | When Created | Due Date |
|------|--------------|----------|
| **Post Standup** | Each business day you're in an active week | Today |
| **Write Hypothesis** | Week start date arrives without hypothesis | Week start |
| **Start Week** | Week start date passes without clicking Start | Week start |
| **Add Issues** | Week starts with no issues assigned | Week start |
| **Complete Review** | Week ends without review | 1 business day after week end |
| **Write Project Hypothesis** | You own a project without a hypothesis | When assigned |
| **Complete Retro** | Project finishes without retrospective | When all issues done |

### Persistent Banner

If you have outstanding items, a banner appears at the top of Ship that cannot be dismissed:

```
┌─────────────────────────────────────────────────────────────────┐
│ 🔴 Your hypothesis awaits. The team awaits. Science awaits.    │
│    3 items need your attention                                  │
└─────────────────────────────────────────────────────────────────┘
```

The banner only disappears when all items are complete.

**Click the banner** to reopen the action items modal at any time.

---

## My Week Integration

The My Week page now shows your action items prominently at the top:

```
┌─────────────────────────────────────────────────────────────────┐
│  My Week                                                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ACTION ITEMS (3)                                    ▼ Collapse │
│  ─────────────────────────────────────────────────────────────  │
│  🔴 Post standup for Week of Jan 274          Due today              │
│  🟡 Write hypothesis for Week of Jan 275      Due Jan 28             │
│  🔴 Complete review for Week of Jan 273       1 day overdue          │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  TODAY'S ISSUES                                                 │
│  ─────────────────────────────────────────────────────────────  │
│  #142 Fix login timeout                 [In Progress]          │
│  #145 Add CSV export                    [Todo]                 │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

Overdue items appear in red with the number of days overdue. Clicking any item takes you directly to the relevant document.

---

## Auto-Complete

When you complete an accountability task, the corresponding action item automatically clears:

| Action | Auto-Completes |
|--------|----------------|
| Post a standup | "Post standup" action item |
| Write week hypothesis | "Write hypothesis" action item |
| Click "Start Week" | "Start week" action item |
| Add first issue to week | "Add issues" action item |
| Create weekly review | "Complete review" action item |
| Write project hypothesis | "Project hypothesis" action item |
| Create project retro | "Project retro" action item |

**Live updates:** When you complete a task, the action items list updates immediately via WebSocket. The banner briefly turns green with a celebration message:

```
┌─────────────────────────────────────────────────────────────────┐
│ 🟢 Nice work! One less thing on your plate. ✨                  │
│    2 items remaining                                            │
└─────────────────────────────────────────────────────────────────┘
```

After 4-5 seconds, the banner returns to red (if items remain) or disappears (if all done).

---

## RACI Assignments

Projects and programs now support RACI role assignments:

```
┌─────────────────────────────────────────────────────────────────┐
│  Project: Authentication System                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  RACI Assignments                                               │
│  ─────────────────                                              │
│                                                                 │
│  Responsible (R):    Alice Chen       (does the work)           │
│  Accountable (A):    Bob Smith        (approves the work)       │
│  Consulted (C):      Carol, Dan       (provides input)          │
│  Informed (I):       Leadership Team  (kept in the loop)        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

| Role | Meaning | In Ship |
|------|---------|---------|
| **Responsible** | Does the work | Project owner (existing field) |
| **Accountable** | Approves the work | New field - can approve hypotheses/reviews |
| **Consulted** | Provides input | New field - future notification support |
| **Informed** | Kept updated | New field - future notification support |

The **Accountable** person (or workspace admin) can approve hypotheses and reviews.

---

## Hypothesis Approval Workflow

Hypotheses and reviews now have an approval workflow to ensure teams aren't changing their hypothesis after the fact.

### Approval States

```
┌──────────────┐    Write/Edit    ┌──────────────────────┐
│   Pending    │ ──────────────▶  │  Pending (no change) │
│   (null)     │                  │                      │
└──────────────┘                  └──────────────────────┘
       │                                    │
       │ Admin approves                     │ Admin approves
       ▼                                    ▼
┌──────────────┐    Edit after    ┌──────────────────────┐
│   Approved   │ ──────────────▶  │  Changed Since       │
│   (green)    │   approval       │  Approved (yellow)   │
└──────────────┘                  └──────────────────────┘
                                           │
                                           │ Admin re-approves
                                           ▼
                                  ┌──────────────────────┐
                                  │      Approved        │
                                  │      (green)         │
                                  └──────────────────────┘
```

### Approving Content

If you're the **Accountable** person or a **workspace admin**, you'll see an Approve button:

```
┌─────────────────────────────────────────────────────────────────┐
│  Week of Jan 274 Properties                                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Hypothesis                                                     │
│  ──────────                                                     │
│  "Adding SSO will reduce login friction..."                     │
│                                                                 │
│  Status: ⚪ Pending approval                                    │
│                                                                 │
│  [Approve Hypothesis]                                           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

After approval:

```
│  Status: ✅ Approved by Bob Smith on Jan 25, 2026               │
```

If content changes after approval:

```
│  Status: ⚠️ Changed since approval                              │
│                                                                 │
│  [View Changes]  [Re-approve]                                   │
```

### Diff Viewer

Click **View Changes** to see exactly what changed since approval:

```
┌─────────────────────────────────────────────────────────────────┐
│  Changes Since Approval                                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  "Adding SSO will reduce login friction and                     │
│   ̶i̶n̶c̶r̶e̶a̶s̶e̶ ̶d̶a̶i̶l̶y̶ ̶a̶c̶t̶i̶v̶e̶ ̶u̶s̶e̶r̶s̶ ̶b̶y̶ ̶1̶5̶%̶                              │
│   decrease support tickets by 50%"                              │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│  🔴 Deleted text (strikethrough)                                │
│  🟢 Added text (highlighted)                                    │
│                                                                 │
│                                    [Close]  [Re-approve]        │
└─────────────────────────────────────────────────────────────────┘
```

---

## Accountability Grid

Managers can now see accountability status across all weeks and projects in a single view.

### Accessing the Grid

1. Click **Programs** in the rail
2. Open your program
3. Click the **Accountability** tab

### Understanding the Grid

```
┌─────────────────────────────────────────────────────────────────┐
│  Accountability Grid                                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│           │ Week of Jan 272  │ Week of Jan 273  │ Week of Jan 274  │ Week of Jan 275   │
│           │  (done)    │  (done)    │  (active)  │ (planning)  │
│  ─────────┼────────────┼────────────┼────────────┼─────────────│
│           │    H│R     │    H│R     │    H│R     │    H│R      │
│  ─────────┼────────────┼────────────┼────────────┼─────────────│
│           │   ✅│✅    │   ✅│✅    │   ✅│⚪    │   ⚪│⚪     │
│           │ ══════════ │ ══════════ │ ══════════ │             │
│  Auth     │   ✅│✅    │   ✅│✅    │            │             │
│  ─────────┼────────────┼────────────┼────────────┼─────────────│
│           │   ✅│✅    │   ✅│⚠️    │   ✅│⚪    │   ⚪│⚪     │
│           │ ══════════ │ ══════════ │ ══════════ │ ══════════  │
│  Mobile   │   ✅│⚪    │   ✅│⚪    │   ✅│⚪    │   ⚪│⚪     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

Legend:
  H = Hypothesis     R = Review/Retro
  ✅ = Complete/Approved
  ⚠️ = Changed since approval (needs re-review)
  ⚪ = Pending/Not started
  ══ = Project timeline (thin colored line)
```

### Grid Features

**Week cells (columns):**
- Left half shows **hypothesis** status
- Right half shows **review** status
- Green border = approved
- Yellow border = changed since approval
- Click any cell to navigate to that week

**Project lines (rows):**
- Thin colored line shows project duration across weeks
- Hover to expand and see project details
- Shows project hypothesis (left) and retro (right) status
- Click to navigate to project document

---

## Plan Block

Weeks now support a `/plan` slash command (formerly `/hypothesis`, which remains as an alias) that creates a dedicated plan block in the editor.

### Using the Command

1. Open any week document
2. Type `/plan` (or the `/hypothesis` alias) in the editor
3. A styled plan block appears:

```
┌─────────────────────────────────────────────────────────────────┐
│  Week of Jan 274                                                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ 💡 HYPOTHESIS                                           │    │
│  │ ───────────────────────────────────────────────────────│    │
│  │                                                         │    │
│  │ What will get done this week?                         │    │
│  │                                                         │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                 │
│  Week goals and planning notes...                             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Bidirectional Sync

The plan block content syncs automatically with the week's `plan` property (renamed from `hypothesis` by migration 032):

- Edit the block → property updates
- Update property via API → block updates
- The plan field has been removed from the properties sidebar

### New Week Default

New weeks are created with a plan block pre-populated with placeholder text.

---

## Standup Enforcement

The standup system now includes additional rules to maintain accountability:

### Current-Day Only

Standups can only be posted for **today**. You cannot backdate standups to previous days.

### Days-Since Tracking

If you miss multiple days, the system tracks how long it's been:

```
┌─────────────────────────────────────────────────────────────────┐
│ 🔴 Post standup for Week of Jan 274 (3 days since last)              │
└─────────────────────────────────────────────────────────────────┘
```

### Issue Deduplication

If you miss multiple days, Ship updates your existing standup reminder rather than creating new issues for each missed day.

---

## Business Day Calculations

All due dates and deadlines now account for federal holidays and weekends:

- Weekends (Saturday/Sunday) are skipped
- Federal holidays (OPM calendar) are skipped
- "1 business day after week end" means the next working day

This ensures you're not penalized for holidays or weekends.

---

## Documentation

Two new guides are available:

| Document | Audience | Topics |
|----------|----------|--------|
| **Accountability Philosophy** | Everyone | Why Ship enforces these behaviors, hypothesis-driven development |
| **Manager Guide** | Admins/Managers | Using the grid, approving content, handling changed states |

Find them in the **Docs** section or at:
- `docs/accountability-philosophy.md`
- `docs/accountability-manager-guide.md`

---

## Summary of Changes

### New Features
- Action items modal on login
- Persistent accountability banner with rotating messages
- My Week action items section
- RACI role assignments
- Hypothesis and review approval workflow
- Inline diff viewer for changes
- Accountability grid view
- `/plan` slash command for weeks (formerly `/hypothesis`; the old name remains as an alias)
- Federal holiday-aware business day calculations

### Improvements
- Standup alerts show week name and issue count
- Action items live-update when tasks are completed
- Celebration animation when completing tasks
- Week properties cleaned up (dates now computed from sprint number)

### Philosophy
- Cannot dismiss accountability reminders - they persist until done
- Cannot delete system-generated action items
- Cannot backdate standups
- Changed hypotheses require re-approval

---

## Getting Started

1. **Check your action items** - Log in and see what needs attention
2. **Set up RACI** - Assign an Accountable person to your projects
3. **Write plans** - Use `/plan` in week documents (the `/hypothesis` alias still works)
4. **Review the grid** - Managers can monitor team accountability

---

*The best teams ship with intention. Now Ship helps you prove it.*
