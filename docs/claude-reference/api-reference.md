# Ship API Reference

This document provides a comprehensive reference for all API endpoints in the Ship application.

## Authentication

All endpoints (except login) require authentication via session cookie (`session_id`).

### POST /api/auth/login

Login with email and password.

**Authentication:** Not required

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "uuid",
      "email": "user@example.com",
      "name": "User Name",
      "isSuperAdmin": false
    },
    "currentWorkspace": {
      "id": "uuid",
      "name": "Workspace Name",
      "role": "admin"
    },
    "workspaces": [...]
  }
}
```

### POST /api/auth/logout

Logout and invalidate session.

**Authentication:** Required

**Response:**
```json
{ "success": true }
```

### GET /api/auth/me

Get current user info and workspaces.

**Authentication:** Required

**Response:**
```json
{
  "success": true,
  "data": {
    "user": { "id", "email", "name", "isSuperAdmin" },
    "currentWorkspace": { "id", "name", "role" },
    "workspaces": [...]
  }
}
```

### GET /api/auth/session

Get session info for timeout tracking.

**Authentication:** Required

**Response:**
```json
{
  "success": true,
  "data": {
    "createdAt": "ISO8601",
    "expiresAt": "ISO8601",
    "absoluteExpiresAt": "ISO8601",
    "lastActivity": "ISO8601"
  }
}
```

### POST /api/auth/extend-session

Extend session timeout (called by "Stay Logged In" button).

**Authentication:** Required

**Response:**
```json
{
  "success": true,
  "data": {
    "expiresAt": "ISO8601",
    "lastActivity": "ISO8601"
  }
}
```

---

## Documents

Documents are the core data model. All ten content types (`wiki`, `issue`, `program`, `project`, `sprint`, `person`, `weekly_plan`, `weekly_retro`, `standup`, `weekly_review`) are stored as documents with a `document_type` field.

### GET /api/documents

List documents with optional filters.

**Authentication:** Required

**Query Parameters:**
- `type` - Filter by document_type (any of: wiki, issue, program, project, sprint, person, weekly_plan, weekly_retro, standup, weekly_review)
- `parent_id` - Filter by parent document (use "null" for root documents)

**Response:**
```json
[
  {
    "id": "uuid",
    "title": "Document Title",
    "document_type": "wiki",
    "parent_id": null,
    "position": 0,
    "visibility": "workspace",
    "created_at": "ISO8601",
    "updated_at": "ISO8601"
  }
]
```

### GET /api/documents/:id

Get a single document by ID.

**Authentication:** Required

**Response:** Document object with flattened properties

**Special Behavior:** Returns 301 redirect if document was converted to another type.

### POST /api/documents

Create a new document.

**Authentication:** Required

**Request Body:**
```json
{
  "title": "Untitled",
  "document_type": "wiki",
  "parent_id": null,
  "visibility": "workspace",
  "content": { "type": "doc", "content": [] }
}
```

### PATCH /api/documents/:id

Update a document.

**Authentication:** Required

**Request Body:** Partial document fields including:
- `title`, `content`, `parent_id`, `position`, `visibility`, `document_type`
- Issue fields: `state`, `priority`, `estimate`, `assignee_id`, `source`, `belongs_to`
- Project fields: `impact`, `confidence`, `ease`, `color`, `owner_id`
- Week fields: `sprint_number`, `owner_id`, `status` (`planning` | `active` | `completed`), `plan`, `success_criteria`, `confidence` (start/end dates are *computed* from `sprint_number` + workspace `sprint_start_date`, not stored)

### DELETE /api/documents/:id

Delete a document.

**Authentication:** Required

**Response:** 204 No Content

### POST /api/documents/:id/convert

Convert document type (issue <-> project).

**Authentication:** Required

**Request Body:**
```json
{ "target_type": "project" }
```

**Response:** New converted document with `converted_from` metadata

### POST /api/documents/:id/undo-conversion

Undo a document conversion.

**Authentication:** Required

**Response:**
```json
{
  "restored_document": { ... },
  "archived_document_id": "uuid",
  "message": "Conversion undone..."
}
```

### GET /api/documents/converted/list

List converted documents for reference.

**Authentication:** Required

**Query Parameters:**
- `original_type` - Filter by original document type
- `converted_type` - Filter by converted document type

---

## Issues

Issues are documents with `document_type = 'issue'`. They have ticket numbers and workflow states.

### GET /api/issues

List issues with optional filters.

**Authentication:** Required

**Query Parameters:**
- `state` - Comma-separated states (triage, backlog, todo, in_progress, in_review, done, cancelled)
- `priority` - urgent, high, medium, low (the API also accepts `none` even though the TypeScript `IssuePriority` type does not list it)
- `assignee_id` - UUID or "null"/"unassigned"
- `program_id` - Filter by program association (translated to a `document_associations` lookup)
- `sprint_id` - Filter by week (sprint) association (translated to a `document_associations` lookup; historical param name)
- `source` - internal or external
- `parent_filter` - top_level, has_children, is_sub_issue

**Response:**
```json
[
  {
    "id": "uuid",
    "title": "Issue Title",
    "ticket_number": 123,
    "display_id": "#123",
    "state": "backlog",
    "priority": "medium",
    "assignee_id": null,
    "estimate": null,
    "belongs_to": [{ "id": "uuid", "type": "project" }]
  }
]
```

### GET /api/issues/:id

Get a single issue by ID.

**Authentication:** Required

### GET /api/issues/by-ticket/:number

Get an issue by ticket number.

**Authentication:** Required

### GET /api/issues/:id/children

Get sub-issues of a parent issue.

**Authentication:** Required

### POST /api/issues

Create a new issue.

**Authentication:** Required

**Request Body:**
```json
{
  "title": "Issue Title",
  "state": "backlog",
  "priority": "medium",
  "assignee_id": null,
  "belongs_to": [{ "id": "uuid", "type": "project" }]
}
```

### PATCH /api/issues/:id

Update an issue.

**Authentication:** Required

**Request Body:**
```json
{
  "title": "Updated Title",
  "state": "in_progress",
  "priority": "high",
  "assignee_id": "uuid",
  "estimate": 3,
  "belongs_to": [...],
  "confirm_orphan_children": false,
  "claude_metadata": {
    "updated_by": "claude",
    "story_id": "string",
    "confidence": 95
  }
}
```

**Special Behavior:** Returns 409 if closing issue with incomplete children (requires `confirm_orphan_children: true`).

### DELETE /api/issues/:id

Delete an issue.

**Authentication:** Required

### GET /api/issues/:id/history

Get change history for an issue.

**Authentication:** Required

**Response:**
```json
[
  {
    "id": "uuid",
    "field": "state",
    "old_value": "backlog",
    "new_value": "in_progress",
    "created_at": "ISO8601",
    "changed_by": { "id": "uuid", "name": "User" },
    "automated_by": "claude"
  }
]
```

### POST /api/issues/:id/history

Log a custom history entry.

**Authentication:** Required

**Request Body:**
```json
{
  "field": "verification",
  "old_value": null,
  "new_value": "passed",
  "automated_by": "claude"
}
```

### POST /api/issues/bulk

Bulk update multiple issues.

**Authentication:** Required

**Request Body:**
```json
{
  "ids": ["uuid1", "uuid2"],
  "action": "update",
  "updates": {
    "state": "done",
    "assignee_id": "uuid",
    "belongs_to": [{ "id": "uuid", "type": "sprint" }]
  }
}
```

**Actions:** archive, delete, restore, update

### POST /api/issues/:id/accept

Accept an issue from triage to backlog.

**Authentication:** Required

### POST /api/issues/:id/reject

Reject an issue from triage with reason.

**Authentication:** Required

**Request Body:**
```json
{ "reason": "Not actionable" }
```

---

## Projects

Projects are documents with `document_type = 'project'`. They use ICE scoring (Impact, Confidence, Ease).

### GET /api/projects

List projects.

**Authentication:** Required

**Query Parameters:**
- `archived` - "true" to include archived
- `sort` - ice_score, impact, confidence, ease, title, updated_at, created_at
- `dir` - asc or desc

**Response:**
```json
[
  {
    "id": "uuid",
    "title": "Project Title",
    "impact": 3,
    "confidence": 4,
    "ease": 2,
    "ice_score": 24,
    "color": "#6366f1",
    "owner": { "id", "name", "email" },
    "week_count": 2,
    "issue_count": 15,
    "inferred_status": "active",
    "is_complete": false,
    "missing_fields": ["plan"]
  }
]
```

### GET /api/projects/:id

Get a single project.

**Authentication:** Required

### POST /api/projects

Create a new project.

**Authentication:** Required

**Request Body:**
```json
{
  "title": "Untitled",
  "impact": null,
  "confidence": null,
  "ease": null,
  "owner_id": null,
  "color": "#6366f1",
  "emoji": null,
  "program_id": null,
  "plan": null,
  "target_date": null
}
```

### PATCH /api/projects/:id

Update a project.

**Authentication:** Required

### DELETE /api/projects/:id

Delete a project.

**Authentication:** Required

### GET /api/projects/:id/issues

Get issues associated with a project.

**Authentication:** Required

### GET /api/projects/:id/weeks

Get weeks associated with a project.

**Authentication:** Required

### POST /api/projects/:id/weeks

Create a week under a project.

**Authentication:** Required

**Request Body:**
```json
{
  "title": "Untitled",
  "sprint_number": null,
  "owner_id": null,
  "goal": null,
  "plan": null,
  "success_criteria": [],
  "confidence": null
}
```

### GET /api/projects/:id/retro

Get project retrospective (pre-filled draft or existing).

**Authentication:** Required

### POST /api/projects/:id/retro

Create/finalize project retrospective.

**Authentication:** Required

**Request Body:**
```json
{
  "plan_validated": true,
  "monetary_impact_actual": "$50K savings",
  "success_criteria": ["Met goal 1", "Met goal 2"],
  "next_steps": "Continue monitoring",
  "content": { "type": "doc", "content": [] }
}
```

### PATCH /api/projects/:id/retro

Update project retrospective.

**Authentication:** Required

---

## Weeks

Weeks are documents with `document_type = 'sprint'` (historical name). They have numbered weeks and a plan-driven workflow (the property was renamed from `hypothesis` to `plan` by migration 032; the underlying philosophy is still hypothesis-driven).

### GET /api/weeks

List active weeks.

**Authentication:** Required

### GET /api/issues/action-items

Get action items for the current user. (Lives under the issues router, not weeks. Was previously documented as `/api/weeks/my-action-items` — that path does not exist.)

**Authentication:** Required

### GET /api/weeks/my-week

Get aggregated issues view for current week.

**Authentication:** Required

### GET /api/weeks/:id

Get a single week.

**Authentication:** Required

### POST /api/weeks

Create a new week.

**Authentication:** Required

### PATCH /api/weeks/:id

Update a week.

**Authentication:** Required

### DELETE /api/weeks/:id

Delete a week.

**Authentication:** Required

### PATCH /api/weeks/:id/plan

Update a week's plan. (Renamed from `/hypothesis` by migration 032.)

**Authentication:** Required

**Request Body:**
```json
{
  "plan": "New plan text",
  "success_criteria": ["Criteria 1", "Criteria 2"],
  "confidence": 75
}
```

### GET /api/weeks/:id/issues

Get issues assigned to a week.

**Authentication:** Required

### GET /api/weeks/:id/scope-changes

Get scope changes (issues added/removed from week).

**Authentication:** Required

### GET /api/weeks/:id/standups

Get standup entries for a week.

**Authentication:** Required

### POST /api/weeks/:id/standups

Create a standup entry.

**Authentication:** Required

**Request Body:**
```json
{
  "content": { "type": "doc", "content": [] },
  "blockers": ["Blocker 1"],
  "mood": "good"
}
```

### GET /api/weeks/:id/review

Get week review (pre-filled draft or existing).

**Authentication:** Required

### POST /api/weeks/:id/review

Create week review.

**Authentication:** Required

### PATCH /api/weeks/:id/review

Update week review.

**Authentication:** Required

---

## Workspaces

Workspaces isolate data between organizations/teams.

### GET /api/workspaces

List user's workspaces.

**Authentication:** Required

### GET /api/workspaces/current

Get current workspace details.

**Authentication:** Required

### POST /api/workspaces/:id/switch

Switch to a different workspace.

**Authentication:** Required

### GET /api/workspaces/:id/members

List workspace members.

**Authentication:** Required (admin only)

### POST /api/workspaces/:id/members

Add a member to workspace.

**Authentication:** Required (admin only)

**Request Body:**
```json
{
  "email": "user@example.com",
  "role": "member"
}
```

### PATCH /api/workspaces/:id/members/:userId

Update member role.

**Authentication:** Required (admin only)

**Request Body:**
```json
{ "role": "admin" }
```

### DELETE /api/workspaces/:id/members/:userId

Remove member from workspace.

**Authentication:** Required (admin only)

### POST /api/workspaces/:id/members/:userId/restore

Restore archived member.

**Authentication:** Required (admin only)

### GET /api/workspaces/:id/invites

List pending invites.

**Authentication:** Required (admin only)

### POST /api/workspaces/:id/invites

Create invitation.

**Authentication:** Required (admin only)

**Request Body:**
```json
{
  "email": "user@example.com",
  "role": "member"
}
```

### DELETE /api/workspaces/:id/invites/:inviteId

Revoke invitation.

**Authentication:** Required (admin only)

### GET /api/workspaces/:id/audit-logs

Get workspace audit logs.

**Authentication:** Required (admin only)

**Query Parameters:**
- `limit` - Number of entries (default 100)
- `offset` - Pagination offset
- `action` - Filter by action type

---

## Files

File upload/download with local development support and S3 production support.

### POST /api/files/upload

Request presigned URL for file upload.

**Authentication:** Required

**Request Body:**
```json
{
  "filename": "document.pdf",
  "mimeType": "application/pdf",
  "sizeBytes": 1024000
}
```

**Response:**
```json
{
  "fileId": "uuid",
  "uploadUrl": "/api/files/{fileId}/local-upload",
  "s3Key": "workspace-id/file-id.pdf"
}
```

**Blocked Extensions:** .exe, .bat, .sh, .js, .dll, .dmg, .pkg, .jar, .ps1, etc.

### POST /api/files/:id/local-upload

Upload file content (local development only).

**Authentication:** Required

**Request Body:** Raw binary file data

### POST /api/files/:id/confirm

Confirm upload complete (for S3 direct uploads).

**Authentication:** Required

**Response:**
```json
{
  "fileId": "uuid",
  "cdnUrl": "/api/files/{fileId}/serve",
  "status": "uploaded"
}
```

### GET /api/files/:id/serve

Serve uploaded file (local development only).

**Authentication:** Required

**Response:** File content with appropriate Content-Type header

### GET /api/files/:id

Get file metadata.

**Authentication:** Required

**Response:**
```json
{
  "id": "uuid",
  "filename": "document.pdf",
  "mime_type": "application/pdf",
  "size_bytes": 1024000,
  "cdn_url": "/api/files/{id}/serve",
  "status": "uploaded",
  "created_at": "ISO8601"
}
```

### DELETE /api/files/:id

Delete a file.

**Authentication:** Required

---

## WebSocket Collaboration

Real-time document collaboration using Yjs CRDTs.

### WebSocket /collaboration/:docType::docId

Connect to real-time collaboration session.

**Authentication:** Required (via session cookie)

**Protocol:** Yjs sync protocol with awareness

**Message Types:**
- `0` - Sync message (document updates)
- `1` - Awareness message (cursor positions, presence)

**Close Codes:**
- `4100` - Document converted (payload contains new doc info)
- `4403` - Access revoked (document made private)

**Rate Limits:**
- 30 connections per IP per minute
- 50 messages per connection per second

**Example Connection:**
```
ws://localhost:3000/collaboration/wiki:550e8400-e29b-41d4-a716-446655440000
```
