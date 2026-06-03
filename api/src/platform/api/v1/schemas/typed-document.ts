import { z } from 'zod';
import { PublicDocumentTypeSchema } from './document.js';

const Uuid = z.string().uuid();
const DateTime = z.string();
const JsonContent = z.unknown().nullable().optional();

export interface TypedDocumentRow {
  id: string;
  document_type: string;
  title: string;
  parent_id: string | null;
  ticket_number: number | null;
  visibility: string;
  properties: Record<string, unknown> | null;
  created_at: Date | string;
  updated_at: Date | string;
  created_by: string | null;
  archived_at?: Date | string | null;
  started_at?: Date | string | null;
  completed_at?: Date | string | null;
  cancelled_at?: Date | string | null;
  reopened_at?: Date | string | null;
  converted_from_id?: string | null;
  content?: unknown;
  created_at_raw?: string;
}

export interface DocumentWriteInput {
  title: string;
  parent_id?: string | null;
  visibility?: 'private' | 'workspace';
  content?: unknown;
  properties: Record<string, unknown>;
}

export interface DocumentUpdateInput {
  title?: string;
  parent_id?: string | null;
  visibility?: 'private' | 'workspace';
  content?: unknown;
  properties?: Record<string, unknown>;
}

export interface TypedDocumentResource {
  /** Public collection path segment under /api/v1. */
  path: string;
  /** Public tag/schema prefix, PascalCase where used in OpenAPI names. */
  name: string;
  /** Backing unified-document type. */
  documentType: z.infer<typeof PublicDocumentTypeSchema>;
  readScope: string;
  writeScope: string;
  description: string;
  responseSchema: z.ZodTypeAny;
  listResponseSchema: z.ZodTypeAny;
  createSchema: z.ZodTypeAny;
  updateSchema: z.ZodTypeAny;
  toResponse: (row: TypedDocumentRow) => unknown;
  toCreate: (input: unknown) => DocumentWriteInput;
  toUpdate: (input: unknown) => DocumentUpdateInput;
  assignTicketNumber?: boolean;
}

function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : v;
}

function isoNullable(v: Date | string | null | undefined): string | null {
  return v == null ? null : iso(v);
}

function props(row: TypedDocumentRow): Record<string, unknown> {
  return row.properties ?? {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function base(row: TypedDocumentRow) {
  return {
    id: row.id,
    title: row.title,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    created_by: row.created_by,
  };
}

function listOf(item: z.ZodTypeAny) {
  return z.object({
    data: z.array(item),
    next_cursor: z.string().nullable(),
  });
}

const BaseCreateSchema = z.object({
  title: z.string().min(1).max(255).optional().default('Untitled'),
  parent_id: Uuid.nullable().optional(),
  visibility: z.enum(['private', 'workspace']).optional(),
  content: z.unknown().optional(),
});

const BaseUpdateSchema = z
  .object({
    title: z.string().min(1).max(255).optional(),
    parent_id: Uuid.nullable().optional(),
    visibility: z.enum(['private', 'workspace']).optional(),
    content: z.unknown().optional(),
  })
  .passthrough();

const WikiPageSchema = z.object({
  id: Uuid,
  title: z.string(),
  parent_id: Uuid.nullable(),
  visibility: z.string(),
  maintainer_id: Uuid.nullable(),
  content: JsonContent,
  created_at: DateTime,
  updated_at: DateTime,
  created_by: Uuid.nullable(),
});
const CreateWikiPageSchema = BaseCreateSchema.extend({
  maintainer_id: Uuid.nullable().optional(),
});
const UpdateWikiPageSchema = BaseUpdateSchema.extend({
  maintainer_id: Uuid.nullable().optional(),
});

const IssueStateSchema = z.enum(['triage', 'backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled']);
const IssuePrioritySchema = z.enum(['urgent', 'high', 'medium', 'low', 'none']);
const IssueSourceSchema = z.enum(['internal', 'external', 'action_items']);
const BelongsToSchema = z.object({
  id: Uuid,
  type: z.enum(['program', 'project', 'sprint', 'parent']),
  title: z.string().optional(),
  color: z.string().optional(),
});
const IssueSchema = z.object({
  id: Uuid,
  title: z.string(),
  display_id: z.string(),
  ticket_number: z.number().int().nullable(),
  state: IssueStateSchema,
  priority: IssuePrioritySchema,
  assignee_id: Uuid.nullable(),
  estimate: z.number().positive().nullable(),
  source: IssueSourceSchema,
  due_date: z.string().nullable(),
  is_system_generated: z.boolean(),
  accountability_target_id: Uuid.nullable(),
  accountability_type: z.string().nullable(),
  rejection_reason: z.string().nullable(),
  content: JsonContent,
  created_at: DateTime,
  updated_at: DateTime,
  created_by: Uuid.nullable(),
  started_at: DateTime.nullable().optional(),
  completed_at: DateTime.nullable().optional(),
  cancelled_at: DateTime.nullable().optional(),
  reopened_at: DateTime.nullable().optional(),
  converted_from_id: Uuid.nullable().optional(),
  belongs_to: z.array(BelongsToSchema),
});
const CreateIssueSchema = BaseCreateSchema.omit({ parent_id: true }).extend({
  title: z.string().min(1).max(500).default('Untitled'),
  state: IssueStateSchema.optional().default('backlog'),
  priority: IssuePrioritySchema.optional().default('medium'),
  assignee_id: Uuid.nullable().optional(),
  estimate: z.number().positive().nullable().optional(),
  source: IssueSourceSchema.optional().default('internal'),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  is_system_generated: z.boolean().optional().default(false),
  accountability_target_id: Uuid.nullable().optional(),
  accountability_type: z.string().nullable().optional(),
});
const UpdateIssueSchema = BaseUpdateSchema.omit({ parent_id: true }).extend({
  state: IssueStateSchema.optional(),
  priority: IssuePrioritySchema.optional(),
  assignee_id: Uuid.nullable().optional(),
  estimate: z.number().positive().nullable().optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  rejection_reason: z.string().nullable().optional(),
});

const ProgramSchema = z.object({
  id: Uuid,
  name: z.string(),
  color: z.string(),
  emoji: z.string().nullable(),
  owner_id: Uuid.nullable(),
  accountable_id: Uuid.nullable(),
  consulted_ids: z.array(Uuid),
  informed_ids: z.array(Uuid),
  issue_count: z.number().int(),
  sprint_count: z.number().int(),
  archived_at: DateTime.nullable(),
  created_at: DateTime,
  updated_at: DateTime,
});
const CreateProgramSchema = BaseCreateSchema.omit({ content: true, parent_id: true }).extend({
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().default('#6366f1'),
  emoji: z.string().max(10).nullable().optional(),
  owner_id: Uuid.nullable().optional(),
  accountable_id: Uuid.nullable().optional(),
  consulted_ids: z.array(Uuid).optional().default([]),
  informed_ids: z.array(Uuid).optional().default([]),
});
const UpdateProgramSchema = BaseUpdateSchema.omit({ content: true, parent_id: true }).extend({
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  emoji: z.string().max(10).nullable().optional(),
  owner_id: Uuid.nullable().optional(),
  accountable_id: Uuid.nullable().optional(),
  consulted_ids: z.array(Uuid).optional(),
  informed_ids: z.array(Uuid).optional(),
});

const ApprovalSchema = z.record(z.unknown()).nullable();
const ProjectSchema = z.object({
  id: Uuid,
  title: z.string(),
  impact: z.number().int().min(1).max(5).nullable(),
  confidence: z.number().int().min(1).max(5).nullable(),
  ease: z.number().int().min(1).max(5).nullable(),
  ice_score: z.number().nullable(),
  color: z.string(),
  emoji: z.string().nullable(),
  program_id: Uuid.nullable(),
  owner_id: Uuid.nullable(),
  accountable_id: Uuid.nullable(),
  consulted_ids: z.array(Uuid),
  informed_ids: z.array(Uuid),
  plan: z.string().nullable(),
  plan_approval: ApprovalSchema,
  retro_approval: ApprovalSchema,
  has_retro: z.boolean(),
  has_design_review: z.boolean().nullable(),
  design_review_notes: z.string().nullable(),
  target_date: z.string().nullable(),
  inferred_status: z.string(),
  sprint_count: z.number().int(),
  issue_count: z.number().int(),
  is_complete: z.boolean().nullable(),
  missing_fields: z.array(z.string()),
  created_at: DateTime,
  updated_at: DateTime,
  archived_at: DateTime.nullable(),
  converted_from_id: Uuid.nullable(),
});
const CreateProjectSchema = BaseCreateSchema.omit({ parent_id: true }).extend({
  impact: z.number().int().min(1).max(5).nullable().optional(),
  confidence: z.number().int().min(1).max(5).nullable().optional(),
  ease: z.number().int().min(1).max(5).nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().default('#6366f1'),
  emoji: z.string().max(10).nullable().optional(),
  program_id: Uuid.nullable().optional(),
  owner_id: Uuid.nullable().optional(),
  accountable_id: Uuid.nullable().optional(),
  consulted_ids: z.array(Uuid).optional().default([]),
  informed_ids: z.array(Uuid).optional().default([]),
  plan: z.string().nullable().optional(),
  target_date: z.string().nullable().optional(),
});
const UpdateProjectSchema = BaseUpdateSchema.omit({ parent_id: true }).extend({
  impact: z.number().int().min(1).max(5).nullable().optional(),
  confidence: z.number().int().min(1).max(5).nullable().optional(),
  ease: z.number().int().min(1).max(5).nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  emoji: z.string().max(10).nullable().optional(),
  program_id: Uuid.nullable().optional(),
  owner_id: Uuid.nullable().optional(),
  accountable_id: Uuid.nullable().optional(),
  consulted_ids: z.array(Uuid).optional(),
  informed_ids: z.array(Uuid).optional(),
  plan: z.string().nullable().optional(),
  target_date: z.string().nullable().optional(),
  has_design_review: z.boolean().nullable().optional(),
  design_review_notes: z.string().nullable().optional(),
});

const SprintSchema = z.object({
  id: Uuid,
  name: z.string(),
  sprint_number: z.number().int().positive(),
  status: z.enum(['planning', 'active', 'completed']),
  owner_id: Uuid.nullable(),
  program_id: Uuid.nullable(),
  plan: z.string().nullable(),
  success_criteria: z.array(z.string()).nullable(),
  confidence: z.number().int().min(0).max(100).nullable(),
  plan_history: z.array(z.record(z.unknown())).nullable(),
  is_complete: z.boolean().nullable(),
  missing_fields: z.array(z.string()),
  planned_issue_ids: z.array(Uuid).nullable(),
  snapshot_taken_at: DateTime.nullable(),
  plan_approval: ApprovalSchema,
  review_approval: ApprovalSchema,
  review_rating: z.record(z.unknown()).nullable(),
  accountable_id: Uuid.nullable(),
  issue_count: z.number().int(),
  completed_count: z.number().int(),
  started_count: z.number().int(),
  has_plan: z.boolean(),
  has_retro: z.boolean(),
  retro_outcome: z.string().nullable(),
  retro_id: Uuid.nullable(),
  created_at: DateTime,
  updated_at: DateTime,
});
const CreateSprintSchema = BaseCreateSchema.omit({ parent_id: true }).extend({
  sprint_number: z.number().int().positive(),
  owner_id: Uuid.nullable().optional(),
  program_id: Uuid.nullable().optional(),
  status: z.enum(['planning', 'active', 'completed']).optional().default('planning'),
  plan: z.string().max(2000).nullable().optional(),
  success_criteria: z.array(z.string().max(500)).max(20).nullable().optional(),
  confidence: z.number().int().min(0).max(100).nullable().optional(),
});
const UpdateSprintSchema = BaseUpdateSchema.omit({ parent_id: true }).extend({
  sprint_number: z.number().int().positive().optional(),
  owner_id: Uuid.nullable().optional(),
  program_id: Uuid.nullable().optional(),
  status: z.enum(['planning', 'active', 'completed']).optional(),
  plan: z.string().max(2000).nullable().optional(),
  success_criteria: z.array(z.string().max(500)).max(20).nullable().optional(),
  confidence: z.number().int().min(0).max(100).nullable().optional(),
});

const PersonSchema = z.object({
  id: Uuid,
  name: z.string(),
  email: z.string().nullable(),
  role: z.string().nullable(),
  capacity_hours: z.number().nullable(),
  reports_to: Uuid.nullable(),
  visibility: z.string(),
  created_at: DateTime,
  updated_at: DateTime,
  created_by: Uuid.nullable(),
});
const CreatePersonSchema = BaseCreateSchema.omit({ content: true, parent_id: true }).extend({
  name: z.string().min(1).max(255).optional(),
  email: z.string().email().nullable().optional(),
  role: z.string().nullable().optional(),
  capacity_hours: z.number().nullable().optional(),
  reports_to: Uuid.nullable().optional(),
});
const UpdatePersonSchema = BaseUpdateSchema.omit({ content: true, parent_id: true }).extend({
  name: z.string().min(1).max(255).optional(),
  email: z.string().email().nullable().optional(),
  role: z.string().nullable().optional(),
  capacity_hours: z.number().nullable().optional(),
  reports_to: Uuid.nullable().optional(),
});

const WeeklyDocSchema = z.object({
  id: Uuid,
  title: z.string(),
  person_id: Uuid.nullable(),
  project_id: Uuid.nullable(),
  week_number: z.number().int().nullable(),
  submitted_at: DateTime.nullable(),
  content: JsonContent,
  created_at: DateTime,
  updated_at: DateTime,
  created_by: Uuid.nullable(),
});
const CreateWeeklyDocSchema = BaseCreateSchema.omit({ parent_id: true }).extend({
  person_id: Uuid.nullable().optional(),
  project_id: Uuid.nullable().optional(),
  week_number: z.number().int().positive().nullable().optional(),
  submitted_at: z.string().nullable().optional(),
});
const UpdateWeeklyDocSchema = BaseUpdateSchema.omit({ parent_id: true }).extend({
  person_id: Uuid.nullable().optional(),
  project_id: Uuid.nullable().optional(),
  week_number: z.number().int().positive().nullable().optional(),
  submitted_at: z.string().nullable().optional(),
});

const StandupSchema = z.object({
  id: Uuid,
  title: z.string(),
  author_id: Uuid.nullable(),
  date: z.string().nullable(),
  submitted_at: DateTime.nullable(),
  content: JsonContent,
  created_at: DateTime,
  updated_at: DateTime,
  created_by: Uuid.nullable(),
});
const CreateStandupSchema = BaseCreateSchema.omit({ parent_id: true }).extend({
  author_id: Uuid.nullable().optional(),
  date: z.string().nullable().optional(),
  submitted_at: z.string().nullable().optional(),
});
const UpdateStandupSchema = BaseUpdateSchema.omit({ parent_id: true }).extend({
  author_id: Uuid.nullable().optional(),
  date: z.string().nullable().optional(),
  submitted_at: z.string().nullable().optional(),
});

const WeeklyReviewSchema = z.object({
  id: Uuid,
  title: z.string(),
  sprint_id: Uuid.nullable(),
  owner_id: Uuid.nullable(),
  plan_validated: z.boolean().nullable(),
  content: JsonContent,
  created_at: DateTime,
  updated_at: DateTime,
  created_by: Uuid.nullable(),
});
const CreateWeeklyReviewSchema = BaseCreateSchema.omit({ parent_id: true }).extend({
  sprint_id: Uuid.nullable().optional(),
  owner_id: Uuid.nullable().optional(),
  plan_validated: z.boolean().nullable().optional(),
});
const UpdateWeeklyReviewSchema = BaseUpdateSchema.omit({ parent_id: true }).extend({
  sprint_id: Uuid.nullable().optional(),
  owner_id: Uuid.nullable().optional(),
  plan_validated: z.boolean().nullable().optional(),
});

function withContent(row: TypedDocumentRow): { content?: unknown } {
  return Object.prototype.hasOwnProperty.call(row, 'content') ? { content: row.content ?? null } : {};
}

function issueResponse(row: TypedDocumentRow) {
  const p = props(row);
  return {
    ...base(row),
    display_id: row.ticket_number != null ? `#${row.ticket_number}` : '',
    ticket_number: row.ticket_number,
    state: (str(p.state) ?? 'backlog') as z.infer<typeof IssueStateSchema>,
    priority: (str(p.priority) ?? 'medium') as z.infer<typeof IssuePrioritySchema>,
    assignee_id: str(p.assignee_id),
    estimate: num(p.estimate),
    source: (str(p.source) ?? 'internal') as z.infer<typeof IssueSourceSchema>,
    due_date: str(p.due_date),
    is_system_generated: bool(p.is_system_generated) ?? false,
    accountability_target_id: str(p.accountability_target_id),
    accountability_type: str(p.accountability_type),
    rejection_reason: str(p.rejection_reason),
    started_at: isoNullable(row.started_at),
    completed_at: isoNullable(row.completed_at),
    cancelled_at: isoNullable(row.cancelled_at),
    reopened_at: isoNullable(row.reopened_at),
    converted_from_id: row.converted_from_id ?? null,
    belongs_to: [],
    ...withContent(row),
  };
}

function writeFromKnownFields(input: Record<string, unknown>, propertyKeys: string[]): DocumentWriteInput {
  const title = typeof input.name === 'string' ? input.name : typeof input.title === 'string' ? input.title : 'Untitled';
  const properties: Record<string, unknown> = {};
  for (const key of propertyKeys) {
    if (Object.prototype.hasOwnProperty.call(input, key)) properties[key] = input[key];
  }
  return {
    title,
    parent_id: (input.parent_id as string | null | undefined) ?? null,
    visibility: input.visibility as 'private' | 'workspace' | undefined,
    content: input.content,
    properties,
  };
}

function updateFromKnownFields(input: Record<string, unknown>, propertyKeys: string[]): DocumentUpdateInput {
  const properties: Record<string, unknown> = {};
  for (const key of propertyKeys) {
    if (Object.prototype.hasOwnProperty.call(input, key)) properties[key] = input[key];
  }
  return {
    title: typeof input.name === 'string' ? input.name : typeof input.title === 'string' ? input.title : undefined,
    parent_id: input.parent_id as string | null | undefined,
    visibility: input.visibility as 'private' | 'workspace' | undefined,
    content: Object.prototype.hasOwnProperty.call(input, 'content') ? input.content : undefined,
    properties: Object.keys(properties).length > 0 ? properties : undefined,
  };
}

function iceScore(impact: number | null, confidence: number | null, ease: number | null): number | null {
  if (impact == null || confidence == null || ease == null) return null;
  return impact * confidence * ease;
}

function createResource(config: Omit<TypedDocumentResource, 'listResponseSchema'>): TypedDocumentResource {
  return { ...config, listResponseSchema: listOf(config.responseSchema) };
}

const issueKeys = ['state', 'priority', 'assignee_id', 'estimate', 'source', 'due_date', 'is_system_generated', 'accountability_target_id', 'accountability_type', 'rejection_reason'];
const programKeys = ['color', 'emoji', 'owner_id', 'accountable_id', 'consulted_ids', 'informed_ids'];
const projectKeys = ['impact', 'confidence', 'ease', 'color', 'emoji', 'program_id', 'owner_id', 'accountable_id', 'consulted_ids', 'informed_ids', 'plan', 'target_date', 'has_design_review', 'design_review_notes'];
const sprintKeys = ['sprint_number', 'owner_id', 'program_id', 'status', 'plan', 'success_criteria', 'confidence'];
const weeklyKeys = ['person_id', 'project_id', 'week_number', 'submitted_at'];
const standupKeys = ['author_id', 'date', 'submitted_at'];
const weeklyReviewKeys = ['sprint_id', 'owner_id', 'plan_validated'];

export const TYPED_DOCUMENT_RESOURCES = [
  createResource({
    path: 'wiki-pages',
    name: 'WikiPage',
    documentType: 'wiki',
    readScope: 'wiki:read',
    writeScope: 'wiki:write',
    description: 'Wiki pages.',
    responseSchema: WikiPageSchema,
    createSchema: CreateWikiPageSchema,
    updateSchema: UpdateWikiPageSchema,
    toResponse: (row) => ({
      ...base(row),
      parent_id: row.parent_id,
      visibility: row.visibility,
      maintainer_id: str(props(row).maintainer_id),
      ...withContent(row),
    }),
    toCreate: (input) => writeFromKnownFields(input as Record<string, unknown>, ['maintainer_id']),
    toUpdate: (input) => updateFromKnownFields(input as Record<string, unknown>, ['maintainer_id']),
  }),
  createResource({
    path: 'issues',
    name: 'Issue',
    documentType: 'issue',
    readScope: 'issues:read',
    writeScope: 'issues:write',
    description: 'Issues.',
    responseSchema: IssueSchema,
    createSchema: CreateIssueSchema,
    updateSchema: UpdateIssueSchema,
    assignTicketNumber: true,
    toResponse: issueResponse,
    toCreate: (input) => writeFromKnownFields(input as Record<string, unknown>, issueKeys),
    toUpdate: (input) => updateFromKnownFields(input as Record<string, unknown>, issueKeys),
  }),
  createResource({
    path: 'programs',
    name: 'Program',
    documentType: 'program',
    readScope: 'programs:read',
    writeScope: 'programs:write',
    description: 'Programs.',
    responseSchema: ProgramSchema,
    createSchema: CreateProgramSchema,
    updateSchema: UpdateProgramSchema,
    toResponse: (row) => {
      const p = props(row);
      return {
        id: row.id,
        name: row.title,
        color: str(p.color) ?? '#6366f1',
        emoji: str(p.emoji),
        owner_id: str(p.owner_id),
        accountable_id: str(p.accountable_id),
        consulted_ids: stringArray(p.consulted_ids),
        informed_ids: stringArray(p.informed_ids),
        issue_count: 0,
        sprint_count: 0,
        archived_at: isoNullable(row.archived_at),
        created_at: iso(row.created_at),
        updated_at: iso(row.updated_at),
      };
    },
    toCreate: (input) => writeFromKnownFields(input as Record<string, unknown>, programKeys),
    toUpdate: (input) => updateFromKnownFields(input as Record<string, unknown>, programKeys),
  }),
  createResource({
    path: 'projects',
    name: 'Project',
    documentType: 'project',
    readScope: 'projects:read',
    writeScope: 'projects:write',
    description: 'Projects.',
    responseSchema: ProjectSchema,
    createSchema: CreateProjectSchema,
    updateSchema: UpdateProjectSchema,
    toResponse: (row) => {
      const p = props(row);
      const impact = num(p.impact);
      const confidence = num(p.confidence);
      const ease = num(p.ease);
      return {
        id: row.id,
        title: row.title,
        impact,
        confidence,
        ease,
        ice_score: iceScore(impact, confidence, ease),
        color: str(p.color) ?? '#6366f1',
        emoji: str(p.emoji),
        program_id: str(p.program_id),
        owner_id: str(p.owner_id),
        accountable_id: str(p.accountable_id),
        consulted_ids: stringArray(p.consulted_ids),
        informed_ids: stringArray(p.informed_ids),
        plan: str(p.plan),
        plan_approval: (p.plan_approval as Record<string, unknown> | null | undefined) ?? null,
        retro_approval: (p.retro_approval as Record<string, unknown> | null | undefined) ?? null,
        has_retro: bool(p.has_retro) ?? false,
        has_design_review: bool(p.has_design_review),
        design_review_notes: str(p.design_review_notes),
        target_date: str(p.target_date),
        inferred_status: str(p.status) ?? 'backlog',
        sprint_count: 0,
        issue_count: 0,
        is_complete: bool(p.is_complete),
        missing_fields: stringArray(p.missing_fields),
        created_at: iso(row.created_at),
        updated_at: iso(row.updated_at),
        archived_at: isoNullable(row.archived_at),
        converted_from_id: row.converted_from_id ?? null,
      };
    },
    toCreate: (input) => writeFromKnownFields(input as Record<string, unknown>, projectKeys),
    toUpdate: (input) => updateFromKnownFields(input as Record<string, unknown>, projectKeys),
  }),
  createResource({
    path: 'sprints',
    name: 'Sprint',
    documentType: 'sprint',
    readScope: 'sprints:read',
    writeScope: 'sprints:write',
    description: 'Sprints.',
    responseSchema: SprintSchema,
    createSchema: CreateSprintSchema,
    updateSchema: UpdateSprintSchema,
    toResponse: (row) => {
      const p = props(row);
      return {
        id: row.id,
        name: row.title,
        sprint_number: num(p.sprint_number) ?? 1,
        status: (str(p.status) ?? 'planning') as 'planning' | 'active' | 'completed',
        owner_id: str(p.owner_id) ?? (Array.isArray(p.assignee_ids) ? str(p.assignee_ids[0]) : null),
        program_id: str(p.program_id),
        plan: str(p.plan),
        success_criteria: Array.isArray(p.success_criteria) ? stringArray(p.success_criteria) : null,
        confidence: num(p.confidence),
        plan_history: Array.isArray(p.plan_history) ? (p.plan_history as Record<string, unknown>[]) : null,
        is_complete: bool(p.is_complete),
        missing_fields: stringArray(p.missing_fields),
        planned_issue_ids: Array.isArray(p.planned_issue_ids) ? stringArray(p.planned_issue_ids) : null,
        snapshot_taken_at: str(p.snapshot_taken_at),
        plan_approval: (p.plan_approval as Record<string, unknown> | null | undefined) ?? null,
        review_approval: (p.review_approval as Record<string, unknown> | null | undefined) ?? null,
        review_rating: (p.review_rating as Record<string, unknown> | null | undefined) ?? null,
        accountable_id: str(p.accountable_id),
        issue_count: 0,
        completed_count: 0,
        started_count: 0,
        has_plan: false,
        has_retro: false,
        retro_outcome: null,
        retro_id: null,
        created_at: iso(row.created_at),
        updated_at: iso(row.updated_at),
      };
    },
    toCreate: (input) => {
      const write = writeFromKnownFields(input as Record<string, unknown>, sprintKeys);
      if (write.properties.owner_id && !write.properties.assignee_ids) {
        write.properties.assignee_ids = [write.properties.owner_id];
      }
      return write;
    },
    toUpdate: (input) => {
      const update = updateFromKnownFields(input as Record<string, unknown>, sprintKeys);
      if (update.properties?.owner_id && !update.properties.assignee_ids) {
        update.properties.assignee_ids = [update.properties.owner_id];
      }
      return update;
    },
  }),
  createResource({
    path: 'people',
    name: 'Person',
    documentType: 'person',
    readScope: 'people:read',
    writeScope: 'people:write',
    description: 'People directory entries.',
    responseSchema: PersonSchema,
    createSchema: CreatePersonSchema,
    updateSchema: UpdatePersonSchema,
    toResponse: (row) => {
      const p = props(row);
      return {
        id: row.id,
        name: row.title,
        email: str(p.email),
        role: str(p.role),
        capacity_hours: num(p.capacity_hours),
        reports_to: str(p.reports_to),
        visibility: row.visibility,
        created_at: iso(row.created_at),
        updated_at: iso(row.updated_at),
        created_by: row.created_by,
      };
    },
    toCreate: (input) => {
      const raw = input as Record<string, unknown>;
      return writeFromKnownFields({ ...raw, title: raw.name ?? raw.title }, ['email', 'role', 'capacity_hours', 'reports_to']);
    },
    toUpdate: (input) => updateFromKnownFields(input as Record<string, unknown>, ['email', 'role', 'capacity_hours', 'reports_to']),
  }),
  createResource({
    path: 'weekly-plans',
    name: 'WeeklyPlan',
    documentType: 'weekly_plan',
    readScope: 'weekly_plans:read',
    writeScope: 'weekly_plans:write',
    description: 'Weekly plans.',
    responseSchema: WeeklyDocSchema,
    createSchema: CreateWeeklyDocSchema,
    updateSchema: UpdateWeeklyDocSchema,
    toResponse: (row) => {
      const p = props(row);
      return { ...base(row), person_id: str(p.person_id), project_id: str(p.project_id), week_number: num(p.week_number), submitted_at: str(p.submitted_at), ...withContent(row) };
    },
    toCreate: (input) => writeFromKnownFields(input as Record<string, unknown>, weeklyKeys),
    toUpdate: (input) => updateFromKnownFields(input as Record<string, unknown>, weeklyKeys),
  }),
  createResource({
    path: 'weekly-retros',
    name: 'WeeklyRetro',
    documentType: 'weekly_retro',
    readScope: 'weekly_retros:read',
    writeScope: 'weekly_retros:write',
    description: 'Weekly retros.',
    responseSchema: WeeklyDocSchema,
    createSchema: CreateWeeklyDocSchema,
    updateSchema: UpdateWeeklyDocSchema,
    toResponse: (row) => {
      const p = props(row);
      return { ...base(row), person_id: str(p.person_id), project_id: str(p.project_id), week_number: num(p.week_number), submitted_at: str(p.submitted_at), ...withContent(row) };
    },
    toCreate: (input) => writeFromKnownFields(input as Record<string, unknown>, weeklyKeys),
    toUpdate: (input) => updateFromKnownFields(input as Record<string, unknown>, weeklyKeys),
  }),
  createResource({
    path: 'standups',
    name: 'Standup',
    documentType: 'standup',
    readScope: 'standups:read',
    writeScope: 'standups:write',
    description: 'Standups.',
    responseSchema: StandupSchema,
    createSchema: CreateStandupSchema,
    updateSchema: UpdateStandupSchema,
    toResponse: (row) => {
      const p = props(row);
      return { ...base(row), author_id: str(p.author_id), date: str(p.date), submitted_at: str(p.submitted_at), ...withContent(row) };
    },
    toCreate: (input) => writeFromKnownFields(input as Record<string, unknown>, standupKeys),
    toUpdate: (input) => updateFromKnownFields(input as Record<string, unknown>, standupKeys),
  }),
  createResource({
    path: 'weekly-reviews',
    name: 'WeeklyReview',
    documentType: 'weekly_review',
    readScope: 'weekly_reviews:read',
    writeScope: 'weekly_reviews:write',
    description: 'Weekly reviews.',
    responseSchema: WeeklyReviewSchema,
    createSchema: CreateWeeklyReviewSchema,
    updateSchema: UpdateWeeklyReviewSchema,
    toResponse: (row) => {
      const p = props(row);
      return { ...base(row), sprint_id: str(p.sprint_id), owner_id: str(p.owner_id), plan_validated: bool(p.plan_validated), ...withContent(row) };
    },
    toCreate: (input) => writeFromKnownFields(input as Record<string, unknown>, weeklyReviewKeys),
    toUpdate: (input) => updateFromKnownFields(input as Record<string, unknown>, weeklyReviewKeys),
  }),
] as const satisfies readonly TypedDocumentResource[];

export const TypedDocumentListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().optional(),
});

export type TypedDocumentResourcePath = (typeof TYPED_DOCUMENT_RESOURCES)[number]['path'];
