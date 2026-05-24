---
title: Shared Collaborative Editor Component Pattern
category: patterns
tags: [react, tiptap, yjs, collaboration, component-reuse]
created: 2024-12-30
problem_type: code_duplication
root_cause: separate_implementations
---

# Shared Collaborative Editor Component Pattern

## Problem

When building multiple document types (documents, issues, notes) that all need collaborative editing, it's tempting to duplicate the TipTap + Yjs setup in each editor component. This leads to:

- ~150+ lines of duplicate WebSocket/Yjs setup per editor
- Inconsistent behavior when one editor is updated but not others
- Harder maintenance when collaboration logic needs changes

**Symptom:** UI changes (like adding a large title) only affect one document type.

## Root Cause

Each document type had its own:
- Yjs document instantiation
- WebSocket provider setup
- Awareness/presence tracking
- TipTap extension configuration
- Editor UI layout

## Solution

Create a single `Editor` component with props for customization:

```typescript
interface EditorProps {
  documentId: string;
  userName: string;
  onTitleChange?: (title: string) => void;
  initialTitle?: string;
  onBack?: () => void;

  // Customization props
  roomPrefix?: string;      // 'doc' | 'issue' - for collaboration room name
  placeholder?: string;     // Editor placeholder text
  headerBadge?: ReactNode;  // Optional badge in header (e.g., issue number)
  sidebar?: ReactNode;      // Optional sidebar content (e.g., issue properties)
}
```

### Key Implementation Details

**1. Room prefix for collaboration isolation:**
```typescript
const wsProvider = new WebsocketProvider(
  wsUrl,
  `${roomPrefix}:${documentId}`,  // e.g., "doc:abc123" or "issue:xyz789"
  ydoc
);
```

**2. Conditional sidebar rendering:**
```typescript
<div className="flex flex-1 overflow-hidden">
  <div className="flex-1 overflow-auto p-8">
    {/* Editor content */}
  </div>
  {sidebar}  {/* Only renders if provided */}
</div>
```

**3. Header badge slot:**
```typescript
{headerBadge}  {/* e.g., <span>#{issue.ticket_number}</span> */}
<span className="flex-1 truncate">{title}</span>
```

### Usage Examples

**Document Editor (simple):**
```typescript
<Editor
  documentId={document.id}
  userName={user.name}
  initialTitle={document.title}
  onTitleChange={handleTitleChange}
  onBack={() => navigate('/docs')}
/>
```

**Issue Editor (with sidebar and badge):**
```typescript
<Editor
  documentId={issue.id}
  userName={user.name}
  initialTitle={issue.title}
  onTitleChange={handleTitleChange}
  onBack={() => navigate('/issues')}
  roomPrefix="issue"
  placeholder="Add a description..."
  headerBadge={<span>#{issue.ticket_number}</span>}
  sidebar={<IssuePropertiesSidebar issue={issue} />}
/>
```

## Results

- **Before:** Each document type had its own editor page (`IssueEditor.tsx`, `DocumentEditor.tsx`) with duplicate TipTap/Yjs code
- **After:** Routing was unified into a single `UnifiedDocumentPage.tsx` that uses the shared `Editor` component
- **Benefit:** Any Editor changes (large title, sync status, presence) apply to all document types

## Prevention

When adding a new document type that needs collaborative editing:
1. Use the shared `Editor` component
2. Add new props if customization is needed
3. Never duplicate the TipTap/Yjs setup

## Related Files

- `web/src/components/Editor.tsx` - Shared editor component
- `web/src/pages/UnifiedDocumentPage.tsx` - Single page that hosts the editor for all document types (issue, project, week, wiki, etc.); the prior `DocumentEditor.tsx` / `IssueEditor.tsx` split has been removed
