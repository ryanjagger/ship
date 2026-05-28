import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { WELCOME_DOCUMENT_TITLE, WELCOME_DOCUMENT_CONTENT } from './welcomeDocument.js';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REQUIRED_ENVIRONMENT = 'dev-railway';
const WORKSPACE_NAME = 'Ship Develop Demo';
const SEED_SOURCE = 'develop-seed';
const SEED_VERSION = '1';
const LATEST_REQUIRED_MIGRATION = '045_fleetgraph_document_types';
const PASSWORD = 'admin123';

type Queryable = pg.Pool | pg.PoolClient;

type FixtureUser = {
  email: string;
  name: string;
};

type UserRecord = {
  id: string;
  email: string;
  name: string;
  person_doc_id: string | null;
};

type ProgramRecord = {
  id: string;
  prefix: string;
  name: string;
};

type ProjectRecord = {
  id: string;
  programId: string;
  title: string;
};

type WeekRecord = {
  id: string;
  programId: string;
  projectId: string;
  number: number;
};

config({ path: join(__dirname, '../../.env.local') });
config({ path: join(__dirname, '../../.env') });

const fixtureUsers: FixtureUser[] = [
  { email: 'dev@ship.local', name: 'Dev User' },
  { email: 'alice.chen@ship.local', name: 'Alice Chen' },
  { email: 'bob.martinez@ship.local', name: 'Bob Martinez' },
  { email: 'carol.williams@ship.local', name: 'Carol Williams' },
  { email: 'david.kim@ship.local', name: 'David Kim' },
  { email: 'emma.johnson@ship.local', name: 'Emma Johnson' },
  { email: 'frank.garcia@ship.local', name: 'Frank Garcia' },
  { email: 'grace.lee@ship.local', name: 'Grace Lee' },
  { email: 'henry.patel@ship.local', name: 'Henry Patel' },
  { email: 'iris.nguyen@ship.local', name: 'Iris Nguyen' },
  { email: 'jack.brown@ship.local', name: 'Jack Brown' },
];

const programsToSeed = [
  { prefix: 'SHIP', name: 'Ship Core', color: '#3B82F6' },
  { prefix: 'AUTH', name: 'Authentication', color: '#8B5CF6' },
  { prefix: 'API', name: 'API Platform', color: '#10B981' },
  { prefix: 'UI', name: 'Design System', color: '#F59E0B' },
  { prefix: 'INFRA', name: 'Infrastructure', color: '#EF4444' },
];

const programTeamNames: Record<string, string[]> = {
  SHIP: ['Dev User', 'Emma Johnson'],
  AUTH: ['Alice Chen', 'Frank Garcia'],
  API: ['Grace Lee', 'Henry Patel'],
  UI: ['Carol Williams', 'David Kim'],
  INFRA: ['Jack Brown', 'Iris Nguyen'],
};

function getTargetEnvironment(): string | undefined {
  return process.env.ENVIRONMENT || process.env.RAILWAY_ENVIRONMENT_NAME;
}

function assertDevelopSeedAllowed(): void {
  const targetEnvironment = getTargetEnvironment();

  if (!targetEnvironment) {
    throw new Error(
      `Refusing to seed: ENVIRONMENT or RAILWAY_ENVIRONMENT_NAME must be ${REQUIRED_ENVIRONMENT}`
    );
  }

  if (targetEnvironment !== REQUIRED_ENVIRONMENT) {
    throw new Error(
      `Refusing to seed ${targetEnvironment}; this command only allows ${REQUIRED_ENVIRONMENT}`
    );
  }

  if (process.env.RAILWAY_ENVIRONMENT_NAME === REQUIRED_ENVIRONMENT && !process.env.ENVIRONMENT) {
    process.env.ENVIRONMENT = REQUIRED_ENVIRONMENT;
  }

  if (process.env.ALLOW_DEVELOP_DB_SEED !== 'true') {
    throw new Error('Refusing to seed without ALLOW_DEVELOP_DB_SEED=true');
  }

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is not set');
  }
}

function describeDatabase(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  return `${url.hostname}/${url.pathname.replace(/^\//, '') || 'unknown'}`;
}

function seededProperties(properties: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...properties,
    seed_source: SEED_SOURCE,
    seed_version: SEED_VERSION,
  };
}

function mondayAboutThreeMonthsAgo(): string {
  const date = new Date();
  date.setMonth(date.getMonth() - 3);
  const dayOfWeek = date.getDay();
  const daysToSubtract = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  date.setDate(date.getDate() - daysToSubtract);
  return date.toISOString().split('T')[0]!;
}

async function assertLatestMigrationApplied(db: Queryable): Promise<void> {
  const migrationTable = await db.query<{ table_name: string | null }>(
    `SELECT to_regclass('public.schema_migrations')::text AS table_name`
  );

  if (!migrationTable.rows[0]?.table_name) {
    throw new Error('schema_migrations does not exist; run pnpm db:migrate before seeding dev-railway');
  }

  const latestMigration = await db.query(
    'SELECT version FROM schema_migrations WHERE version = $1',
    [LATEST_REQUIRED_MIGRATION]
  );

  if (!latestMigration.rows[0]) {
    throw new Error(`${LATEST_REQUIRED_MIGRATION} is not applied; run pnpm db:migrate before seeding dev-railway`);
  }
}

async function createAssociation(
  db: Queryable,
  documentId: string,
  relatedId: string,
  relationshipType: 'program' | 'project' | 'sprint'
): Promise<void> {
  await db.query(
    `INSERT INTO document_associations (document_id, related_id, relationship_type, metadata)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (document_id, related_id, relationship_type) DO NOTHING`,
    [documentId, relatedId, relationshipType, JSON.stringify(seededProperties({ created_via: SEED_SOURCE }))]
  );
}

async function getOrCreateWorkspace(db: Queryable): Promise<string> {
  const existingWorkspace = await db.query(
    'SELECT id FROM workspaces WHERE name = $1',
    [WORKSPACE_NAME]
  );

  if (existingWorkspace.rows[0]) {
    return existingWorkspace.rows[0].id;
  }

  const workspace = await db.query(
    `INSERT INTO workspaces (name, sprint_start_date)
     VALUES ($1, $2)
     RETURNING id`,
    [WORKSPACE_NAME, mondayAboutThreeMonthsAgo()]
  );
  return workspace.rows[0].id;
}

async function upsertFixtureUsers(db: Queryable, workspaceId: string): Promise<UserRecord[]> {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  for (const user of fixtureUsers) {
    const existing = await db.query(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1)',
      [user.email]
    );

    if (existing.rows[0]) {
      await db.query(
        `UPDATE users
         SET name = $1, password_hash = $2, last_workspace_id = $3
         WHERE id = $4`,
        [user.name, passwordHash, workspaceId, existing.rows[0].id]
      );
    } else {
      await db.query(
        `INSERT INTO users (email, password_hash, name, last_workspace_id)
         VALUES ($1, $2, $3, $4)`,
        [user.email, passwordHash, user.name, workspaceId]
      );
    }
  }

  await db.query(
    `UPDATE users
     SET is_super_admin = true, last_workspace_id = $1
     WHERE LOWER(email) = 'dev@ship.local'`,
    [workspaceId]
  );

  const emails = fixtureUsers.map(user => user.email.toLowerCase());
  const users = await db.query<UserRecord>(
    `SELECT u.id, u.email, u.name, d.id as person_doc_id
     FROM users u
     LEFT JOIN documents d ON d.workspace_id = $1
       AND d.document_type = 'person'
       AND d.properties->>'user_id' = u.id::text
     WHERE LOWER(u.email) = ANY($2::text[])
     ORDER BY array_position($2::text[], LOWER(u.email))`,
    [workspaceId, emails]
  );

  for (const user of users.rows) {
    const role = user.email.toLowerCase() === 'dev@ship.local' ? 'admin' : 'member';
    await db.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [workspaceId, user.id, role]
    );

    if (!user.person_doc_id) {
      const personDoc = await db.query(
        `INSERT INTO documents (workspace_id, document_type, title, properties, created_by)
         VALUES ($1, 'person', $2, $3, $4)
         RETURNING id`,
        [
          workspaceId,
          user.name,
          JSON.stringify(seededProperties({ user_id: user.id, email: user.email })),
          user.id,
        ]
      );
      user.person_doc_id = personDoc.rows[0].id;
    } else {
      await db.query(
        `UPDATE documents
         SET title = $1,
             properties = properties || $2::jsonb
         WHERE id = $3`,
        [
          user.name,
          JSON.stringify(seededProperties({ user_id: user.id, email: user.email })),
          user.person_doc_id,
        ]
      );
    }
  }

  const emailToUserId = new Map(users.rows.map(user => [user.email.toLowerCase(), user.id]));
  const reportingHierarchy: Record<string, string | null> = {
    'dev@ship.local': null,
    'alice.chen@ship.local': 'dev@ship.local',
    'bob.martinez@ship.local': 'dev@ship.local',
    'carol.williams@ship.local': 'dev@ship.local',
    'david.kim@ship.local': 'alice.chen@ship.local',
    'emma.johnson@ship.local': 'alice.chen@ship.local',
    'frank.garcia@ship.local': 'bob.martinez@ship.local',
    'grace.lee@ship.local': 'bob.martinez@ship.local',
    'henry.patel@ship.local': 'carol.williams@ship.local',
    'iris.nguyen@ship.local': 'carol.williams@ship.local',
    'jack.brown@ship.local': 'carol.williams@ship.local',
  };

  for (const [email, managerEmail] of Object.entries(reportingHierarchy)) {
    if (!managerEmail) continue;
    const userId = emailToUserId.get(email);
    const managerId = emailToUserId.get(managerEmail);
    if (!userId || !managerId) continue;

    await db.query(
      `UPDATE documents
       SET properties = properties || jsonb_build_object('reports_to', $1::text)
       WHERE workspace_id = $2
         AND document_type = 'person'
         AND properties->>'user_id' = $3`,
      [managerId, workspaceId, userId]
    );
  }

  return users.rows;
}

async function seedPrograms(db: Queryable, workspaceId: string): Promise<ProgramRecord[]> {
  const programs: ProgramRecord[] = [];

  for (const program of programsToSeed) {
    const existing = await db.query(
      `SELECT id FROM documents
       WHERE workspace_id = $1
         AND document_type = 'program'
         AND properties->>'prefix' = $2`,
      [workspaceId, program.prefix]
    );

    if (existing.rows[0]) {
      programs.push({ id: existing.rows[0].id, prefix: program.prefix, name: program.name });
      continue;
    }

    const inserted = await db.query(
      `INSERT INTO documents (workspace_id, document_type, title, properties)
       VALUES ($1, 'program', $2, $3)
       RETURNING id`,
      [workspaceId, program.name, JSON.stringify(seededProperties({ prefix: program.prefix, color: program.color }))]
    );
    programs.push({ id: inserted.rows[0].id, prefix: program.prefix, name: program.name });
  }

  return programs;
}

async function seedProjects(
  db: Queryable,
  workspaceId: string,
  programs: ProgramRecord[],
  users: UserRecord[]
): Promise<ProjectRecord[]> {
  const templates = [
    { name: 'Core Features', color: '#6366f1', impact: 5, confidence: 4, ease: 3 },
    { name: 'Bug Fixes', color: '#ef4444', impact: 4, confidence: 5, ease: 4 },
    { name: 'Performance', color: '#22c55e', impact: 4, confidence: 3, ease: 2 },
  ];
  const projects: ProjectRecord[] = [];

  for (const program of programs) {
    for (let i = 0; i < templates.length; i++) {
      const template = templates[i]!;
      const title = `${program.name} - ${template.name}`;
      const existing = await db.query(
        `SELECT id FROM documents
         WHERE workspace_id = $1 AND document_type = 'project' AND title = $2`,
        [workspaceId, title]
      );

      if (existing.rows[0]) {
        projects.push({ id: existing.rows[0].id, programId: program.id, title });
        await createAssociation(db, existing.rows[0].id, program.id, 'program');
        continue;
      }

      const owner = users[(programs.indexOf(program) + i) % users.length]!;
      const targetDate = new Date();
      targetDate.setDate(targetDate.getDate() + (i + 2) * 7);
      const inserted = await db.query(
        `INSERT INTO documents (workspace_id, document_type, title, properties)
         VALUES ($1, 'project', $2, $3)
         RETURNING id`,
        [
          workspaceId,
          title,
          JSON.stringify(seededProperties({
            color: template.color,
            owner_id: owner.id,
            impact: template.impact,
            confidence: template.confidence,
            ease: template.ease,
            plan: `${template.name} work improves the develop demo data set.`,
            monetary_impact_expected: (i + 1) * 15000,
            target_date: targetDate.toISOString().split('T')[0],
          })),
        ]
      );
      const projectId = inserted.rows[0].id;
      await createAssociation(db, projectId, program.id, 'program');
      projects.push({ id: projectId, programId: program.id, title });
    }
  }

  return projects;
}

async function seedWeeks(
  db: Queryable,
  workspaceId: string,
  programs: ProgramRecord[],
  projects: ProjectRecord[],
  users: UserRecord[]
): Promise<{ currentWeek: number; weeks: WeekRecord[] }> {
  const workspace = await db.query('SELECT sprint_start_date FROM workspaces WHERE id = $1', [workspaceId]);
  const sprintStartDate = new Date(workspace.rows[0].sprint_start_date);
  const daysSinceStart = Math.floor((Date.now() - sprintStartDate.getTime()) / (1000 * 60 * 60 * 24));
  const currentWeek = Math.max(1, Math.floor(daysSinceStart / 7) + 1);
  const weeks: WeekRecord[] = [];

  for (const program of programs) {
    const programProjects = projects.filter(project => project.programId === program.id);
    const team = users.filter(user => (programTeamNames[program.prefix] || []).includes(user.name));
    const weekOwners = team.length > 0 ? team : users;

    for (let weekNumber = currentWeek - 2; weekNumber <= currentWeek + 2; weekNumber++) {
      if (weekNumber < 1) continue;

      const project = programProjects[(weekNumber + programs.indexOf(program)) % programProjects.length]!;
      const owner = weekOwners[weekNumber % weekOwners.length]!;
      const other = weekOwners.find(user => user.id !== owner.id) || owner;
      const existing = await db.query(
        `SELECT d.id FROM documents d
         JOIN document_associations da ON da.document_id = d.id
           AND da.related_id = $2
           AND da.relationship_type = 'project'
         WHERE d.workspace_id = $1
           AND d.document_type = 'sprint'
           AND (d.properties->>'sprint_number')::int = $3`,
        [workspaceId, project.id, weekNumber]
      );

      if (existing.rows[0]) {
        weeks.push({ id: existing.rows[0].id, programId: program.id, projectId: project.id, number: weekNumber });
        await createAssociation(db, existing.rows[0].id, program.id, 'program');
        continue;
      }

      const status = weekNumber < currentWeek ? 'completed' : weekNumber === currentWeek ? 'active' : undefined;
      const inserted = await db.query(
        `INSERT INTO documents (workspace_id, document_type, title, properties)
         VALUES ($1, 'sprint', $2, $3)
         RETURNING id`,
        [
          workspaceId,
          `Week ${weekNumber}`,
          JSON.stringify(seededProperties({
            sprint_number: weekNumber,
            owner_id: owner.id,
            project_id: project.id,
            assignee_ids: [owner.person_doc_id, other.person_doc_id].filter(Boolean),
            plan: 'Ship a realistic slice of demo work for this week.',
            success_criteria: 'Planned issues are visible and progress data is populated.',
            confidence: weekNumber <= currentWeek ? 80 : 55,
            ...(status && { status }),
          })),
        ]
      );
      const weekId = inserted.rows[0].id;
      await createAssociation(db, weekId, project.id, 'project');
      await createAssociation(db, weekId, program.id, 'program');
      weeks.push({ id: weekId, programId: program.id, projectId: project.id, number: weekNumber });
    }
  }

  return { currentWeek, weeks };
}

async function nextTicketNumber(db: Queryable, workspaceId: string): Promise<number> {
  const result = await db.query(
    `SELECT COALESCE(MAX(ticket_number), 0) + 1 AS next_number
     FROM documents
     WHERE workspace_id = $1 AND document_type = 'issue'`,
    [workspaceId]
  );
  return Number(result.rows[0].next_number);
}

async function seedIssues(
  db: Queryable,
  workspaceId: string,
  programs: ProgramRecord[],
  projects: ProjectRecord[],
  weeks: WeekRecord[],
  currentWeek: number,
  users: UserRecord[]
): Promise<void> {
  const issueTemplates = [
    { title: 'Initial project setup', state: 'done', priority: 'high', estimate: 8, weekOffset: -2 },
    { title: 'Implement core feature flow', state: 'done', priority: 'high', estimate: 6, weekOffset: -1 },
    { title: 'Fix high-priority bugs', state: 'in_progress', priority: 'high', estimate: 5, weekOffset: 0 },
    { title: 'Build dashboard polish', state: 'todo', priority: 'medium', estimate: 4, weekOffset: 0 },
    { title: 'Add regression tests', state: 'todo', priority: 'medium', estimate: 4, weekOffset: 1 },
    { title: 'Performance optimization', state: 'backlog', priority: 'low', estimate: 6, weekOffset: null },
  ];

  let ticketNumber = await nextTicketNumber(db, workspaceId);

  for (const program of programs) {
    const programProjects = projects.filter(project => project.programId === program.id);
    const team = users.filter(user => (programTeamNames[program.prefix] || []).includes(user.name));
    const assignees = team.length > 0 ? team : users;

    for (let i = 0; i < issueTemplates.length; i++) {
      const template = issueTemplates[i]!;
      const title = `${program.prefix}: ${template.title}`;
      const existing = await db.query(
        `SELECT id FROM documents
         WHERE workspace_id = $1 AND document_type = 'issue' AND title = $2`,
        [workspaceId, title]
      );

      if (existing.rows[0]) continue;

      const assignee = assignees[i % assignees.length]!;
      const inserted = await db.query(
        `INSERT INTO documents (workspace_id, document_type, title, properties, ticket_number)
         VALUES ($1, 'issue', $2, $3, $4)
         RETURNING id`,
        [
          workspaceId,
          title,
          JSON.stringify(seededProperties({
            state: template.state,
            priority: template.priority,
            estimate: template.estimate,
            source: 'internal',
            assignee_id: assignee.id,
            feedback_status: null,
            rejection_reason: null,
          })),
          ticketNumber++,
        ]
      );
      const issueId = inserted.rows[0].id;
      await createAssociation(db, issueId, program.id, 'program');

      const week = template.weekOffset === null
        ? undefined
        : weeks.find(candidate => candidate.programId === program.id && candidate.number === currentWeek + template.weekOffset);
      const project = week
        ? programProjects.find(candidate => candidate.id === week.projectId)
        : programProjects[i % programProjects.length];

      if (project) {
        await createAssociation(db, issueId, project.id, 'project');
      }
      if (week) {
        await createAssociation(db, issueId, week.id, 'sprint');
      }
    }
  }
}

async function seedWikiDocs(db: Queryable, workspaceId: string): Promise<void> {
  const tutorial = await db.query(
    `SELECT id FROM documents
     WHERE workspace_id = $1 AND document_type = 'wiki' AND title = $2`,
    [workspaceId, WELCOME_DOCUMENT_TITLE]
  );

  let tutorialId = tutorial.rows[0]?.id;
  if (!tutorialId) {
    const inserted = await db.query(
      `INSERT INTO documents (workspace_id, document_type, title, content, position, properties)
       VALUES ($1, 'wiki', $2, $3, 0, $4)
       RETURNING id`,
      [
        workspaceId,
        WELCOME_DOCUMENT_TITLE,
        JSON.stringify(WELCOME_DOCUMENT_CONTENT),
        JSON.stringify(seededProperties()),
      ]
    );
    tutorialId = inserted.rows[0].id;
  }

  const docs = [
    { title: 'Getting Started', parentId: tutorialId, content: 'How to navigate the dev demo workspace.' },
    { title: 'Architecture Guide', parentId: null, content: 'Technical architecture and design decisions.' },
    { title: 'API Reference', parentId: null, content: 'API endpoint examples for the dev demo.' },
  ];

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i]!;
    const existing = await db.query(
      `SELECT id FROM documents
       WHERE workspace_id = $1
         AND document_type = 'wiki'
         AND title = $2
         AND parent_id IS NOT DISTINCT FROM $3::uuid`,
      [workspaceId, doc.title, doc.parentId]
    );

    if (existing.rows[0]) continue;

    await db.query(
      `INSERT INTO documents (workspace_id, document_type, title, parent_id, content, position, properties)
       VALUES ($1, 'wiki', $2, $3, $4, $5, $6)`,
      [
        workspaceId,
        doc.title,
        doc.parentId,
        JSON.stringify({
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: doc.content }] }],
        }),
        i + 1,
        JSON.stringify(seededProperties()),
      ]
    );
  }
}

async function seedStandupsAndWeeklyDocs(
  db: Queryable,
  workspaceId: string,
  weeks: WeekRecord[],
  currentWeek: number,
  users: UserRecord[]
): Promise<void> {
  const shipWeeks = weeks.filter(week => week.number >= currentWeek - 1 && week.number <= currentWeek);
  const authors = users.slice(0, 3);

  for (const week of shipWeeks) {
    for (let i = 0; i < authors.length; i++) {
      const author = authors[i]!;
      const existing = await db.query(
        `SELECT d.id FROM documents d
         JOIN document_associations da ON da.document_id = d.id
           AND da.related_id = $2
           AND da.relationship_type = 'sprint'
         WHERE d.workspace_id = $1
           AND d.document_type = 'standup'
           AND d.created_by = $3`,
        [workspaceId, week.id, author.id]
      );

      if (!existing.rows[0]) {
        const inserted = await db.query(
          `INSERT INTO documents (workspace_id, document_type, title, content, created_by, properties, created_at)
           VALUES ($1, 'standup', $2, $3, $4, $5, NOW() - ($6::int * INTERVAL '1 day'))
           RETURNING id`,
          [
            workspaceId,
            `Standup - ${author.name}`,
            JSON.stringify({
              type: 'doc',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'Yesterday: advanced planned demo work.' }] },
                { type: 'paragraph', content: [{ type: 'text', text: 'Today: validating the next slice.' }] },
                { type: 'paragraph', content: [{ type: 'text', text: 'Blockers: none.' }] },
              ],
            }),
            author.id,
            JSON.stringify(seededProperties({ author_id: author.id })),
            i,
          ]
        );
        await createAssociation(db, inserted.rows[0].id, week.id, 'sprint');
      }
    }
  }

  for (const week of weeks.filter(candidate => candidate.number <= currentWeek)) {
    const assignees = users.slice(0, 2);
    for (const assignee of assignees) {
      if (!assignee.person_doc_id) continue;

      const planExists = await db.query(
        `SELECT id FROM documents
         WHERE workspace_id = $1 AND document_type = 'weekly_plan'
           AND properties->>'person_id' = $2
           AND (properties->>'week_number')::int = $3
           AND properties->>'project_id' = $4`,
        [workspaceId, assignee.person_doc_id, week.number, week.projectId]
      );

      if (!planExists.rows[0]) {
        await db.query(
          `INSERT INTO documents (workspace_id, document_type, title, content, properties, visibility, created_by)
           VALUES ($1, 'weekly_plan', $2, $3, $4, 'workspace', $5)`,
          [
            workspaceId,
            `Week ${week.number} Plan`,
            JSON.stringify({
              type: 'doc',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Complete priority demo tasks and document outcomes.' }] }],
            }),
            JSON.stringify(seededProperties({
              person_id: assignee.person_doc_id,
              project_id: week.projectId,
              week_number: week.number,
              submitted_at: new Date().toISOString(),
            })),
            assignee.id,
          ]
        );
      }

      if (week.number >= currentWeek) continue;

      const retroExists = await db.query(
        `SELECT id FROM documents
         WHERE workspace_id = $1 AND document_type = 'weekly_retro'
           AND properties->>'person_id' = $2
           AND (properties->>'week_number')::int = $3
           AND properties->>'project_id' = $4`,
        [workspaceId, assignee.person_doc_id, week.number, week.projectId]
      );

      if (!retroExists.rows[0]) {
        await db.query(
          `INSERT INTO documents (workspace_id, document_type, title, content, properties, visibility, created_by)
           VALUES ($1, 'weekly_retro', $2, $3, $4, 'workspace', $5)`,
          [
            workspaceId,
            `Week ${week.number} Retro`,
            JSON.stringify({
              type: 'doc',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Delivered planned work and captured follow-up improvements.' }] }],
            }),
            JSON.stringify(seededProperties({
              person_id: assignee.person_doc_id,
              project_id: week.projectId,
              week_number: week.number,
              submitted_at: new Date().toISOString(),
            })),
            assignee.id,
          ]
        );
      }
    }
  }
}

async function summarize(db: Queryable, workspaceId: string): Promise<void> {
  const documentCounts = await db.query<{ document_type: string; count: string }>(
    `SELECT document_type::text, COUNT(*)::text AS count
     FROM documents
     WHERE workspace_id = $1
     GROUP BY document_type
     ORDER BY document_type`,
    [workspaceId]
  );
  const memberships = await db.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM workspace_memberships WHERE workspace_id = $1',
    [workspaceId]
  );

  console.log('');
  console.log('Seed summary:');
  console.log(`  Workspace: ${WORKSPACE_NAME} (${workspaceId})`);
  console.log(`  Memberships: ${memberships.rows[0]?.count || '0'}`);
  for (const row of documentCounts.rows) {
    console.log(`  ${row.document_type}: ${row.count}`);
  }
}

async function run(): Promise<void> {
  assertDevelopSeedAllowed();

  const resetWorkspace = process.env.DEVELOP_SEED_RESET === 'true';
  console.log('Starting guarded dev-railway seed...');
  console.log(`  Environment: ${getTargetEnvironment()}`);
  console.log(`  Database: ${describeDatabase(process.env.DATABASE_URL!)}`);
  console.log(`  Workspace: ${WORKSPACE_NAME}`);
  console.log(`  Mode: ${resetWorkspace ? 'reset' : 'additive'}`);

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, ['ship-develop-seed']);
    await assertLatestMigrationApplied(client);

    if (resetWorkspace) {
      await client.query('DELETE FROM workspaces WHERE name = $1', [WORKSPACE_NAME]);
    }

    const workspaceId = await getOrCreateWorkspace(client);
    const users = await upsertFixtureUsers(client, workspaceId);
    const programs = await seedPrograms(client, workspaceId);
    const projects = await seedProjects(client, workspaceId, programs, users);
    const { currentWeek, weeks } = await seedWeeks(client, workspaceId, programs, projects, users);

    await seedIssues(client, workspaceId, programs, projects, weeks, currentWeek, users);
    await seedWikiDocs(client, workspaceId);
    await seedStandupsAndWeeklyDocs(client, workspaceId, weeks, currentWeek, users);
    await summarize(client, workspaceId);
    await client.query('COMMIT');

    console.log('');
    console.log('Develop seed complete.');
    console.log('Login credentials:');
    console.log('  Email: dev@ship.local');
    console.log(`  Password: ${PASSWORD}`);
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original seed failure.
    }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((error) => {
  console.error('Develop seed failed:', error);
  process.exit(1);
});
