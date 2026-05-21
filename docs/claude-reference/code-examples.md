# Ship Code Examples

Common patterns with real code examples from the codebase.

## API Route Pattern

From `api/src/routes/issues.ts`:

```typescript
import { Router, Request, Response } from 'express';
import { pool } from '../db/client.js';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { getVisibilityContext, VISIBILITY_FILTER_SQL } from '../middleware/visibility.js';

type RouterType = ReturnType<typeof Router>;
const router: RouterType = Router();

// 1. Zod schema at top
const createIssueSchema = z.object({
  title: z.string().min(1).max(500),
  state: z.enum(['triage', 'backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled']).optional(),
  priority: z.enum(['urgent', 'high', 'medium', 'low']).optional(),
  belongs_to: z.array(belongsToEntrySchema).optional().default([]),
});

// 2. Row extractor function
function extractIssueFromRow(row: any): Issue {
  return {
    id: row.id,
    title: row.title,
    document_type: 'issue',
    properties: {
      state: row.state,
      priority: row.priority,
      assignee_id: row.assignee_id,
    },
    // ... other fields
  };
}

// 3. Route with authMiddleware
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const workspaceId = req.workspaceId!;
    const { isAdmin } = await getVisibilityContext(req.userId!, workspaceId);

    const result = await pool.query(
      `SELECT d.*,
              d.properties->>'state' as state,
              d.properties->>'priority' as priority
       FROM documents d
       WHERE d.workspace_id = $1
         AND d.document_type = 'issue'
         AND ${VISIBILITY_FILTER_SQL('d', '$2', '$3')}
       ORDER BY d.created_at DESC`,
      [workspaceId, req.userId, isAdmin]
    );

    res.json(result.rows.map(extractIssueFromRow));
  } catch (error) {
    console.error('Error fetching issues:', error);
    res.status(500).json({ error: 'Failed to fetch issues' });
  }
});

// 4. POST with Zod validation
router.post('/', authMiddleware, async (req: Request, res: Response) => {
  const parsed = createIssueSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.errors });
    return;
  }

  const { title, state, priority, belongs_to } = parsed.data;

  // ... create logic
});

export default router;
```

## Database Transaction Pattern

From `api/src/routes/issues.ts:513-582`:

```typescript
router.delete('/:id', authMiddleware, async (req: Request, res: Response) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Check if issue exists and user has access
    const issueResult = await client.query(
      'SELECT * FROM documents WHERE id = $1 AND document_type = $2',
      [req.params.id, 'issue']
    );

    if (issueResult.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Issue not found' });
      return;
    }

    // Delete associations first (foreign key constraint)
    await client.query(
      'DELETE FROM document_associations WHERE document_id = $1 OR related_id = $1',
      [req.params.id]
    );

    // Delete the document
    await client.query(
      'DELETE FROM documents WHERE id = $1',
      [req.params.id]
    );

    await client.query('COMMIT');
    res.status(204).send();
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deleting issue:', error);
    res.status(500).json({ error: 'Failed to delete issue' });
  } finally {
    client.release();
  }
});
```

## TanStack Query Hook Pattern

From `web/src/hooks/useIssuesQuery.ts`:

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

// Query key factory
export const issueKeys = {
  all: ['issues'] as const,
  lists: () => [...issueKeys.all, 'list'] as const,
  list: (filters: IssueFilters) => [...issueKeys.lists(), filters] as const,
  details: () => [...issueKeys.all, 'detail'] as const,
  detail: (id: string) => [...issueKeys.details(), id] as const,
};

// Query hook
export function useIssuesQuery(filters: IssueFilters = {}) {
  return useQuery({
    queryKey: issueKeys.list(filters),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters.projectId) params.set('project_id', filters.projectId);
      if (filters.state) params.set('state', filters.state);

      const response = await api.get(`/api/issues?${params}`);
      return response.data;
    },
    staleTime: 30 * 1000, // 30 seconds
  });
}

// Mutation with optimistic update
export function useCreateIssue() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: CreateIssueInput) => {
      const response = await api.post('/api/issues', data);
      return response.data;
    },
    onMutate: async (newIssue) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: issueKeys.lists() });

      // Snapshot previous value
      const previousIssues = queryClient.getQueryData(issueKeys.lists());

      // Optimistically update
      queryClient.setQueryData(issueKeys.lists(), (old: Issue[] = []) => [
        { ...newIssue, id: 'temp-' + Date.now() },
        ...old,
      ]);

      return { previousIssues };
    },
    onError: (err, newIssue, context) => {
      // Rollback on error
      queryClient.setQueryData(issueKeys.lists(), context?.previousIssues);
    },
    onSettled: () => {
      // Refetch after mutation
      queryClient.invalidateQueries({ queryKey: issueKeys.lists() });
    },
  });
}
```

## Context + Hook Pattern

From `web/src/contexts/WorkspaceContext.tsx`:

```typescript
import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { api } from '@/lib/api';

interface WorkspaceContextType {
  workspace: Workspace | null;
  workspaces: Workspace[];
  loading: boolean;
  switchWorkspace: (id: string) => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceContextType | undefined>(undefined);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadWorkspaces() {
      try {
        const [current, all] = await Promise.all([
          api.get('/api/workspaces/current'),
          api.get('/api/workspaces'),
        ]);
        setWorkspace(current.data);
        setWorkspaces(all.data);
      } catch (error) {
        console.error('Failed to load workspaces:', error);
      } finally {
        setLoading(false);
      }
    }
    loadWorkspaces();
  }, []);

  const switchWorkspace = async (id: string) => {
    await api.post(`/api/workspaces/${id}/switch`);
    window.location.reload(); // Full reload to reset all state
  };

  return (
    <WorkspaceContext.Provider value={{ workspace, workspaces, loading, switchWorkspace }}>
      {children}
    </WorkspaceContext.Provider>
  );
}

// Typed hook with error if used outside provider
export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (context === undefined) {
    throw new Error('useWorkspace must be used within a WorkspaceProvider');
  }
  return context;
}
```

## TipTap Extension Pattern

From `web/src/components/editor/DetailsExtension.ts`:

```typescript
import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { DetailsNodeView } from './DetailsNodeView';

export const DetailsExtension = Node.create({
  name: 'details',
  group: 'block',
  content: 'detailsSummary detailsContent',

  addAttributes() {
    return {
      open: {
        default: true,
        parseHTML: element => element.hasAttribute('open'),
        renderHTML: attributes => {
          if (!attributes.open) return {};
          return { open: '' };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'details' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['details', mergeAttributes(HTMLAttributes), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(DetailsNodeView);
  },

  addCommands() {
    return {
      toggleDetails: () => ({ commands }) => {
        return commands.toggleWrap(this.name);
      },
    };
  },
});
```

## Visibility Filter Pattern

From `api/src/middleware/visibility.ts`:

```typescript
import { pool } from '../db/client.js';

export async function getVisibilityContext(userId: string, workspaceId: string) {
  const result = await pool.query(
    `SELECT role FROM workspace_memberships
     WHERE user_id = $1 AND workspace_id = $2`,
    [userId, workspaceId]
  );

  const isAdmin = result.rows[0]?.role === 'admin';
  return { isAdmin };
}

// SQL fragment for visibility filtering
// Usage: WHERE ${VISIBILITY_FILTER_SQL('d', '$2', '$3')}
export function VISIBILITY_FILTER_SQL(
  tableAlias: string,
  userIdParam: string,
  isAdminParam: string
): string {
  return `(
    ${tableAlias}.visibility = 'workspace'
    OR ${tableAlias}.created_by = ${userIdParam}
    OR ${isAdminParam} = TRUE
  )`;
}
```

## Migration Pattern

From `api/src/db/migrations/020_document_associations.sql`:

```sql
-- Migration: Create document_associations table
-- Purpose: Flexible many-to-many document relationships

-- Create the associations table
CREATE TABLE IF NOT EXISTS document_associations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    related_id  UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    relationship_type relationship_type NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB DEFAULT '{}',

    -- Prevent duplicate associations
    CONSTRAINT unique_association
        UNIQUE (document_id, related_id, relationship_type),

    -- Prevent self-references
    CONSTRAINT no_self_reference
        CHECK (document_id != related_id)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_document_associations_document_id
    ON document_associations(document_id);
CREATE INDEX IF NOT EXISTS idx_document_associations_related_id
    ON document_associations(related_id);
CREATE INDEX IF NOT EXISTS idx_document_associations_type
    ON document_associations(relationship_type);

COMMENT ON TABLE document_associations IS
    'Flexible document relationships replacing fixed FK columns';
```

## E2E Test Pattern

From `e2e/fixtures/isolated-env.ts`:

```typescript
import { test as base, expect } from '@playwright/test';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

// Extend base test with isolated environment
export const test = base.extend<{}, { workerDatabase: PostgreSqlContainer }>({
  // Worker-scoped database container
  workerDatabase: [async ({}, use, workerInfo) => {
    const container = await new PostgreSqlContainer('postgres:16')
      .withDatabase('ship_test')
      .withUsername('test')
      .withPassword('test')
      .start();

    // Run migrations
    await runMigrations(container.getConnectionUri());

    // Seed minimal test data
    await seedMinimalTestData(container.getConnectionUri());

    await use(container);

    await container.stop();
  }, { scope: 'worker' }],

  // Page with authenticated session
  page: async ({ page, workerDatabase }, use) => {
    // Login before each test
    await page.goto('/login');
    await page.fill('#email', 'dev@ship.local');
    await page.fill('#password', 'admin123');
    await page.click('button[type="submit"]');
    await page.waitForURL('/');

    await use(page);
  },
});

// Usage in test file
test('can create issue', async ({ page }) => {
  await page.goto('/projects/test-project/issues');
  await page.click('[data-testid="create-issue"]');
  await page.fill('[data-testid="issue-title"]', 'Test Issue');
  await page.click('[data-testid="save-issue"]');

  await expect(page.locator('text=Test Issue')).toBeVisible();
});
```

## Yjs Collaboration Setup

From `web/src/components/Editor.tsx`:

```typescript
import { useEditor } from '@tiptap/react';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';

function Editor({ documentId, documentType }: EditorProps) {
  // Create Y.Doc keyed by documentId to prevent cross-contamination
  const ydoc = useMemo(() => new Y.Doc(), [documentId]);

  // IndexedDB persistence (loads before WebSocket)
  useEffect(() => {
    const persistence = new IndexeddbPersistence(`ship-${documentId}`, ydoc);

    persistence.on('synced', () => {
      console.log('[Editor] IndexedDB synced');
    });

    return () => persistence.destroy();
  }, [ydoc, documentId]);

  // WebSocket provider
  useEffect(() => {
    const wsUrl = `${import.meta.env.VITE_WS_URL}/collaboration`;
    const roomName = `${documentType}:${documentId}`;

    const provider = new WebsocketProvider(wsUrl, roomName, ydoc, {
      connect: true,
    });

    provider.on('status', ({ status }) => {
      setSyncStatus(status === 'connected' ? 'synced' : 'connecting');
    });

    // Handle special close codes
    provider.on('connection-close', (event) => {
      if (event.code === 4403) {
        // Access revoked
        navigate('/documents');
      } else if (event.code === 4100) {
        // Document converted
        const { newDocId, newDocType } = JSON.parse(event.reason);
        navigate(`/${newDocType}s/${newDocId}`);
      }
    });

    return () => provider.destroy();
  }, [ydoc, documentId, documentType]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ history: false }), // Disable history for Yjs
      Collaboration.configure({ document: ydoc }),
      CollaborationCursor.configure({
        provider,
        user: { name: currentUser.name, color: currentUser.color },
      }),
      // ... other extensions
    ],
  });

  return <EditorContent editor={editor} />;
}
```

## Session Validation Pattern

From `api/src/middleware/auth.ts`:

```typescript
import { Request, Response, NextFunction } from 'express';
import { pool } from '../db/client.js';
import { SESSION_TIMEOUT_MS, ABSOLUTE_SESSION_TIMEOUT_MS } from '@ship/shared';

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Check for API token first
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const result = await pool.query(
      `SELECT * FROM api_tokens
       WHERE token_hash = $1
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > NOW())`,
      [tokenHash]
    );

    if (result.rows.length > 0) {
      req.userId = result.rows[0].user_id;
      req.workspaceId = result.rows[0].workspace_id;
      req.isApiToken = true;
      return next();
    }
  }

  // Check session cookie
  const sessionId = req.cookies?.session_id;
  if (!sessionId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const result = await pool.query(
    `SELECT s.*, u.is_super_admin
     FROM sessions s
     JOIN users u ON s.user_id = u.id
     WHERE s.id = $1`,
    [sessionId]
  );

  if (result.rows.length === 0) {
    return res.status(401).json({ error: 'Invalid session' });
  }

  const session = result.rows[0];

  // Check inactivity timeout
  const inactivityExpired =
    Date.now() - new Date(session.last_activity).getTime() > SESSION_TIMEOUT_MS;

  // Check absolute timeout
  const absoluteExpired =
    Date.now() - new Date(session.created_at).getTime() > ABSOLUTE_SESSION_TIMEOUT_MS;

  if (inactivityExpired || absoluteExpired) {
    await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
    res.clearCookie('session_id');
    return res.status(401).json({ error: 'Session expired' });
  }

  // Update last activity
  await pool.query(
    'UPDATE sessions SET last_activity = NOW() WHERE id = $1',
    [sessionId]
  );

  req.userId = session.user_id;
  req.workspaceId = session.workspace_id;
  req.isSuperAdmin = session.is_super_admin;

  next();
}
```
