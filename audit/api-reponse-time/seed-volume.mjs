import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const requireFromApi = createRequire(new URL('../../api/package.json', import.meta.url));
const pg = requireFromApi('pg');
const summaryOnly = process.argv.includes('--summary-only');

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  const env = readFileSync(new URL('../../api/.env.local', import.meta.url), 'utf8');
  const match = env.match(/^DATABASE_URL=(.+)$/m);
  if (!match) {
    throw new Error('DATABASE_URL was not found in api/.env.local');
  }
  return match[1].trim().replace(/^['"]|['"]$/g, '');
}

const pool = new pg.Pool({ connectionString: loadDatabaseUrl() });

const content = (text) => ({
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text }] },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text:
            'Audit seed content with enough structure to exercise document list, search, backlinks, issue, project, and dashboard queries under realistic volume.',
        },
      ],
    },
  ],
});

async function getWorkspaceId() {
  const result = await pool.query(
    "SELECT id FROM workspaces WHERE name = 'Ship Workspace' ORDER BY created_at LIMIT 1"
  );
  if (!result.rows[0]) {
    throw new Error('Ship Workspace not found. Run pnpm db:seed first.');
  }
  return result.rows[0].id;
}

async function seedUsers(workspaceId) {
  const dev = await pool.query(
    "SELECT password_hash FROM users WHERE email = 'dev@ship.local' LIMIT 1"
  );
  const passwordHash = dev.rows[0]?.password_hash ?? null;
  const users = [];

  for (let i = 1; i <= 24; i++) {
    const n = String(i).padStart(2, '0');
    const email = `audit.user.${n}@ship.local`;
    const name = `Audit User ${n}`;
    const user = await pool.query(
      `INSERT INTO users (email, password_hash, name, last_workspace_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE
         SET name = EXCLUDED.name, last_workspace_id = EXCLUDED.last_workspace_id
       RETURNING id, email, name`,
      [email, passwordHash, name, workspaceId]
    );
    users.push(user.rows[0]);

    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role)
       VALUES ($1, $2, 'member')
       ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      [workspaceId, user.rows[0].id]
    );

    const personExists = await pool.query(
      `SELECT id FROM documents
       WHERE workspace_id = $1 AND document_type = 'person' AND properties->>'user_id' = $2`,
      [workspaceId, user.rows[0].id]
    );
    if (!personExists.rows[0]) {
      await pool.query(
        `INSERT INTO documents (workspace_id, document_type, title, properties, created_by)
         VALUES ($1, 'person', $2, $3, $4)`,
        [
          workspaceId,
          name,
          JSON.stringify({
            user_id: user.rows[0].id,
            email,
            capacity_hours: 32 + (i % 4) * 4,
            skills: ['planning', 'delivery', i % 2 === 0 ? 'frontend' : 'backend'],
          }),
          user.rows[0].id,
        ]
      );
    }
  }

  return users;
}

async function ensureWiki(workspaceId, title, parentId, position, createdBy) {
  const existing = await pool.query(
    `SELECT id FROM documents
     WHERE workspace_id = $1 AND document_type = 'wiki' AND title = $2 AND
       (($3::uuid IS NULL AND parent_id IS NULL) OR parent_id = $3::uuid)
     LIMIT 1`,
    [workspaceId, title, parentId]
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const inserted = await pool.query(
    `INSERT INTO documents (workspace_id, document_type, title, parent_id, position, content, properties, created_by)
     VALUES ($1, 'wiki', $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      workspaceId,
      title,
      parentId,
      position,
      JSON.stringify(content(title)),
      JSON.stringify({ source: 'api-response-time-audit', section: parentId ? 'leaf' : 'folder' }),
      createdBy,
    ]
  );
  return inserted.rows[0].id;
}

async function seedWikiDocuments(workspaceId, users) {
  const rootIds = [];
  for (let folder = 1; folder <= 20; folder++) {
    const rootTitle = `Audit Knowledge Area ${String(folder).padStart(2, '0')}`;
    const rootId = await ensureWiki(
      workspaceId,
      rootTitle,
      null,
      1000 + folder,
      users[folder % users.length].id
    );
    rootIds.push(rootId);

    for (let doc = 1; doc <= 16; doc++) {
      await ensureWiki(
        workspaceId,
        `${rootTitle} - Runbook ${String(doc).padStart(2, '0')}`,
        rootId,
        doc,
        users[(folder + doc) % users.length].id
      );
    }
  }
  return rootIds;
}

async function seedIssues(workspaceId, users) {
  const programs = await pool.query(
    "SELECT id, title FROM documents WHERE workspace_id = $1 AND document_type = 'program' ORDER BY title",
    [workspaceId]
  );
  const projects = await pool.query(
    `SELECT d.id, d.title, da.related_id AS program_id
     FROM documents d
     JOIN document_associations da ON da.document_id = d.id AND da.relationship_type = 'program'
     WHERE d.workspace_id = $1 AND d.document_type = 'project'
     ORDER BY d.title`,
    [workspaceId]
  );
  const sprints = await pool.query(
    `SELECT d.id, d.title, da.related_id AS project_id
     FROM documents d
     JOIN document_associations da ON da.document_id = d.id AND da.relationship_type = 'project'
     WHERE d.workspace_id = $1 AND d.document_type = 'sprint'
     ORDER BY (d.properties->>'sprint_number')::int`,
    [workspaceId]
  );

  const maxTicketResult = await pool.query(
    `SELECT COALESCE(MAX(ticket_number), 0)::int AS max_ticket
     FROM documents
     WHERE workspace_id = $1 AND document_type = 'issue'`,
    [workspaceId]
  );
  let nextTicket = maxTicketResult.rows[0].max_ticket;

  for (let i = 1; i <= 96; i++) {
    const title = `Audit Load Issue ${String(i).padStart(3, '0')}`;
    const existing = await pool.query(
      "SELECT id FROM documents WHERE workspace_id = $1 AND document_type = 'issue' AND title = $2",
      [workspaceId, title]
    );
    if (existing.rows[0]) continue;

    const program = programs.rows[i % programs.rows.length];
    const programProjects = projects.rows.filter((project) => project.program_id === program.id);
    const project = programProjects[i % programProjects.length] ?? projects.rows[i % projects.rows.length];
    const projectSprints = sprints.rows.filter((sprint) => sprint.project_id === project.id);
    const sprint = projectSprints[i % projectSprints.length] ?? sprints.rows[i % sprints.rows.length];
    const assignee = users[i % users.length];

    nextTicket += 1;
    const state = ['backlog', 'todo', 'in_progress', 'in_review', 'done'][i % 5];
    const priority = ['urgent', 'high', 'medium', 'low'][i % 4];
    const inserted = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, content, properties, ticket_number, created_by)
       VALUES ($1, 'issue', $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        workspaceId,
        title,
        JSON.stringify(content(title)),
        JSON.stringify({
          state,
          priority,
          source: 'internal',
          assignee_id: assignee.id,
          estimate: 1 + (i % 13),
          audit_batch: 'api-response-time',
        }),
        nextTicket,
        assignee.id,
      ]
    );

    const issueId = inserted.rows[0].id;
    const associations = [
      [issueId, program.id, 'program'],
      [issueId, project.id, 'project'],
      [issueId, sprint.id, 'sprint'],
    ];
    for (const [documentId, relatedId, type] of associations) {
      await pool.query(
        `INSERT INTO document_associations (document_id, related_id, relationship_type, metadata)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (document_id, related_id, relationship_type) DO NOTHING`,
        [documentId, relatedId, type, JSON.stringify({ source: 'api-response-time-audit' })]
      );
    }
  }
}

async function seedLinks(workspaceId) {
  const docs = await pool.query(
    `SELECT id FROM documents
     WHERE workspace_id = $1 AND document_type IN ('wiki', 'issue')
     ORDER BY created_at DESC
     LIMIT 220`,
    [workspaceId]
  );
  for (let i = 0; i < docs.rows.length - 1; i++) {
    if (i % 3 !== 0) continue;
    await pool.query(
      `INSERT INTO document_links (source_id, target_id)
       VALUES ($1, $2)
       ON CONFLICT (source_id, target_id) DO NOTHING`,
      [docs.rows[i].id, docs.rows[i + 1].id]
    );
  }
}

async function summarize(workspaceId) {
  const counts = await pool.query(
    `SELECT document_type, count(*)::int AS count
     FROM documents
     WHERE workspace_id = $1 AND deleted_at IS NULL
     GROUP BY document_type
     ORDER BY document_type`,
    [workspaceId]
  );
  const users = await pool.query('SELECT count(*)::int AS count FROM users');
  return {
    users: users.rows[0].count,
    documents: counts.rows.reduce((sum, row) => sum + row.count, 0),
    documentTypes: counts.rows,
  };
}

const workspaceId = await getWorkspaceId();
if (!summaryOnly) {
  const users = await seedUsers(workspaceId);
  await seedWikiDocuments(workspaceId, users);
  await seedIssues(workspaceId, users);
  await seedLinks(workspaceId);
}
console.log(JSON.stringify(await summarize(workspaceId), null, 2));
await pool.end();
