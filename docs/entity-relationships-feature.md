# Entity Relationships & Documentation Quality

This document describes the entity relationship improvements and documentation quality features being added to Ship.

## Overview

Ship's entity model follows a hierarchy: **Program → Project → Week → Issue**. This feature set improves visibility into these relationships, adds activity visualization, and enforces documentation quality.

## Entity Hierarchy

```
Program (Vision + Goals)
├── Projects (Hypothesis + Success Criteria)
│   ├── Weeks (Goal + Date Range + Linked Issues)
│   │   ├── Issues (flexible, can be unassigned initially)
│   │   └── Standups (daily updates, reference issues)
│   └── Issues (can belong directly to project)
└── Weeks (can belong directly to program)
```

### Key Decisions

| Entity | Required Fields for "Complete" |
|--------|------------------------------|
| Program | Vision, Goals |
| Project | Hypothesis, Success Criteria |
| Week | Goal, Date Range, At least 1 linked issue |
| Issue | Nothing required (inbox → triage model) |
| Wiki | Standalone (linked via @mentions, not hierarchy) |

## Features

### 1. Program Projects Tab

Programs now have a **Projects** tab showing all associated projects.

**Views:**
- **List View**: Table with project name, status, key metrics
- **Card View**: Visual cards with mini activity charts

Toggle between views with a button in the tab header.

### 2. Activity Charts

GitHub-style activity visualization showing 30 days of activity.

**Activity Types Tracked:**
- Document edits
- Issue state changes
- Standup posts

**Component:** No standalone `ActivityChart` component currently exists in `web/src/components/`. The visualization, where present, is rendered inline by the consuming page. This section describes the intended shape.

**API Endpoint:** `GET /api/activity/:entityType/:entityId`

**Response Format:**
```json
{
  "days": [
    { "date": "2026-01-14", "count": 5 },
    { "date": "2026-01-13", "count": 2 }
  ]
}
```

### 3. Plan & Success Criteria Blocks

Special structured sections in Project and Week documents.

**Slash Commands:**
- `/plan` - Insert Plan section (formerly `/hypothesis`; `hypothesis` remains as an alias)
- `/criteria` - Insert Success Criteria section

**Detection:**
Also detects existing H2 headings named "Plan", "Hypothesis", or "Success Criteria" (case-insensitive).

**Storage Model:**
Dual storage - content is source of truth, syncs to `properties.plan` and `properties.success_criteria` on save. The property was renamed from `hypothesis` → `plan` by migration 032. This enables:
- Fast queries on properties
- Normal rich-text editing experience
- Search/filter by plan content

### 4. Program Vision & Goals

Programs have different structured sections than Projects.

**Slash Commands (Program only):**
- `/vision` - Insert Vision section (strategic direction)
- `/goals` - Insert Goals section (objectives)

**Storage:** Syncs to `properties.vision` and `properties.goals`.

### 5. Incomplete Document Flags

Documents missing critical fields are flagged but not blocked from saving.

**Visual Indicators:**
- **Banner**: Yellow warning at top of document listing missing fields
- **Badge**: Orange indicator in sidebar and document lists

**Completeness Rules:**
```javascript
// Project is complete if:
properties.plan && properties.success_criteria

// Week is complete if:
properties.goal && properties.start_date && properties.end_date && linked_issues.length > 0
```

### 6. Standup Auto-Linking

Automatic detection and linking of issue references in standup content.

**Patterns Detected:**
- `#123` → Link to issue with ticket_number 123
- `issue #123` → Same
- `ISS-123` → Same

**Behavior:**
- Detected patterns become clickable links
- Links navigate to `/issues/:id`
- Non-existent issue numbers render as plain text

### 7. UI Polish

**Standup Font Scaling:**
- Headings in standup feed scaled to ~60% of normal size
- Preserves hierarchy (H1 > H2 > H3)
- Body text remains readable

**Badge No-Wrap:**
- All badge/pill elements prevent text wrapping
- Long text shows ellipsis
- Applies to: state badges, tags, priority indicators

## Implementation Notes

### Database Changes

No schema migrations required. All new data stored in existing `properties` JSONB column:
- `properties.plan` - text (renamed from `hypothesis` by migration 032)
- `properties.success_criteria` - text
- `properties.vision` - text
- `properties.goals` - text
- `properties.is_complete` - boolean

### API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/activity/:entityType/:entityId` | Activity data for charts |
| Existing document endpoints | Modified to sync structured sections |

### Components

| Component | Location | Purpose |
|-----------|----------|---------|
| _ActivityChart_ | _(not yet extracted as a standalone component)_ | Activity visualization — rendered inline by consuming pages |
| _IncompleteBanner_ | _(not yet extracted as a standalone component)_ | Warning banner for incomplete docs — rendered inline by consuming pages |
| Slash commands | TipTap extensions | `/plan` (alias `/hypothesis`), `/criteria`, `/vision`, `/goals` |

## Related

- [Unified Document Model](./unified-document-model.md) - Core data model
- [Document Model Conventions](./document-model-conventions.md) - Terminology and patterns
- [Week Documentation Philosophy](./week-documentation-philosophy.md) - Week workflow
