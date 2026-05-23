import { Router, Request, Response } from 'express';
import { pool } from '../db/client.js';
import { authMiddleware } from '../middleware/auth.js';
import { z } from 'zod';

type RouterType = ReturnType<typeof Router>;
const router: RouterType = Router();

// Valid entity types for activity queries
const entityTypeSchema = z.enum(['program', 'project', 'sprint']);

/**
 * @swagger
 * /activity/{entityType}/{entityId}:
 *   get:
 *     summary: Get activity data for an entity
 *     description: Returns 30 days of activity counts for the specified entity and its children
 *     tags: [Activity]
 *     parameters:
 *       - in: path
 *         name: entityType
 *         required: true
 *         schema:
 *           type: string
 *           enum: [program, project, sprint]
 *       - in: path
 *         name: entityId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Activity data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 days:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       date:
 *                         type: string
 *                         format: date
 *                       count:
 *                         type: integer
 *       400:
 *         description: Invalid entity type
 *       404:
 *         description: Entity not found
 */
router.get('/:entityType/:entityId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { entityType, entityId } = req.params;
    const workspaceId = req.workspaceId;

    // Validate entity type
    const typeResult = entityTypeSchema.safeParse(entityType);
    if (!typeResult.success) {
      res.status(400).json({ error: 'Invalid entity type. Must be program, project, or week.' });
      return;
    }

    // Verify entity exists and belongs to workspace
    const entityCheck = await pool.query(
      `SELECT id FROM documents
       WHERE id = $1 AND workspace_id = $2 AND document_type = $3`,
      [entityId, workspaceId, entityType]
    );

    if (entityCheck.rows.length === 0) {
      res.status(404).json({ error: 'Entity not found' });
      return;
    }

    // Build query based on entity type
    // Activity includes:
    // - Document edits (updated_at changes)
    // - Issue state changes (tracked via document updates)
    // - Standup posts (created_at for standups)
    let activityQuery: string;

    switch (entityType) {
      case 'program':
        // Program activity: documents directly linked to program + documents in its projects + documents in its sprints
        activityQuery = `
          WITH date_range AS (
            SELECT generate_series(
              CURRENT_DATE - INTERVAL '29 days',
              CURRENT_DATE,
              INTERVAL '1 day'
            )::date AS date
          ),
          program_projects AS (
            SELECT d.id FROM documents d
            JOIN document_associations da ON d.id = da.document_id
              AND da.relationship_type = 'program' AND da.related_id = $1
            WHERE d.document_type = 'project' AND d.workspace_id = $2
          ),
          program_sprints AS (
            SELECT d.id FROM documents d
            JOIN document_associations da ON d.id = da.document_id
              AND da.relationship_type = 'project' AND da.related_id IN (SELECT id FROM program_projects)
            WHERE d.document_type = 'sprint' AND d.workspace_id = $2
          ),
          activity_counts AS (
            SELECT updated_at::date AS activity_date, COUNT(*) AS count
            FROM documents
            WHERE workspace_id = $2
              AND (
                -- Direct program documents (linked via document_associations)
                id IN (SELECT document_id FROM document_associations WHERE related_id = $1 AND relationship_type = 'program')
                -- Project documents (linked to projects in this program)
                OR id IN (SELECT document_id FROM document_associations WHERE related_id IN (SELECT id FROM program_projects) AND relationship_type = 'project')
                -- Sprint documents (issues, standups linked via document_associations)
                OR id IN (SELECT document_id FROM document_associations WHERE related_id IN (SELECT id FROM program_sprints) AND relationship_type = 'sprint')
                -- The program document itself
                OR id = $1
              )
              AND updated_at >= CURRENT_DATE - INTERVAL '29 days'
            GROUP BY updated_at::date
          )
          SELECT dr.date::text, COALESCE(ac.count, 0)::integer AS count
          FROM date_range dr
          LEFT JOIN activity_counts ac ON dr.date = ac.activity_date
          ORDER BY dr.date ASC
        `;
        break;

      case 'project':
        // Project activity: documents directly linked to project + documents in its sprints
        activityQuery = `
          WITH date_range AS (
            SELECT generate_series(
              CURRENT_DATE - INTERVAL '29 days',
              CURRENT_DATE,
              INTERVAL '1 day'
            )::date AS date
          ),
          project_sprints AS (
            SELECT da.document_id as id FROM document_associations da
            JOIN documents d ON d.id = da.document_id
            WHERE da.related_id = $1 AND da.relationship_type = 'project'
              AND d.document_type = 'sprint' AND d.workspace_id = $2
          ),
          activity_counts AS (
            SELECT updated_at::date AS activity_date, COUNT(*) AS count
            FROM documents
            WHERE workspace_id = $2
              AND (
                -- Sprints linked to this project via document_associations
                id IN (SELECT id FROM project_sprints)
                -- Documents linked to sprints via junction table (issues)
                OR id IN (SELECT da.document_id FROM document_associations da
                          JOIN project_sprints ps ON ps.id = da.related_id AND da.relationship_type = 'sprint')
                -- Documents linked directly to project via junction table (issues)
                OR id IN (SELECT document_id FROM document_associations WHERE related_id = $1 AND relationship_type = 'project')
                -- The project document itself
                OR id = $1
              )
              AND updated_at >= CURRENT_DATE - INTERVAL '29 days'
            GROUP BY updated_at::date
          )
          SELECT dr.date::text, COALESCE(ac.count, 0)::integer AS count
          FROM date_range dr
          LEFT JOIN activity_counts ac ON dr.date = ac.activity_date
          ORDER BY dr.date ASC
        `;
        break;

      case 'sprint':
        // Sprint activity: documents directly linked to sprint + the sprint itself
        activityQuery = `
          WITH date_range AS (
            SELECT generate_series(
              CURRENT_DATE - INTERVAL '29 days',
              CURRENT_DATE,
              INTERVAL '1 day'
            )::date AS date
          ),
          activity_counts AS (
            SELECT updated_at::date AS activity_date, COUNT(*) AS count
            FROM documents
            WHERE workspace_id = $2
              AND (
                -- Documents linked to this sprint via junction table (issues)
                id IN (SELECT document_id FROM document_associations WHERE related_id = $1 AND relationship_type = 'sprint')
                -- The sprint document itself
                OR id = $1
              )
              AND updated_at >= CURRENT_DATE - INTERVAL '29 days'
            GROUP BY updated_at::date
          )
          SELECT dr.date::text, COALESCE(ac.count, 0)::integer AS count
          FROM date_range dr
          LEFT JOIN activity_counts ac ON dr.date = ac.activity_date
          ORDER BY dr.date ASC
        `;
        break;

      default:
        res.status(400).json({ error: 'Invalid entity type' });
        return;
    }

    const result = await pool.query(activityQuery, [entityId, workspaceId]);

    res.json({
      days: result.rows.map(row => ({
        date: row.date,
        count: row.count,
      })),
    });
  } catch (error) {
    console.error('Activity fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch activity data' });
  }
});

export default router;
