import type { Request } from "express";
import type { Pool, PoolClient } from "pg";

export interface LogActivityInput {
  action: string; // e.g. "student.admit", "concession.grant", "payment.void"
  entityType: string; // e.g. "student", "enrollment", "payment"
  entityId?: string | null;
  description: string; // human-readable summary, shown directly in the log screen
  metadata?: Record<string, unknown>;
}

/**
 * Records one audit entry. Takes the same client a route is already
 * using for its own writes (a transaction client, or the plain pool for
 * routes with nothing to wrap in a transaction) so the log entry commits
 * or rolls back atomically with the action it describes — a failed
 * admission should never leave behind a log entry claiming it
 * succeeded, and a successful one should never lose its log entry to an
 * unrelated later failure.
 *
 * user_name and user_role are read from req.user/req.membership and
 * frozen into the row at write time (see the audit_log migration for
 * why) — never looked up again afterward.
 */
export async function logActivity(
  client: PoolClient | Pool,
  req: Request,
  input: LogActivityInput,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log
       (school_id, user_id, user_name, user_role, action, entity_type, entity_id, description, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      req.school!.id,
      req.user!.id,
      req.user!.full_name || req.user!.email,
      req.membership!.role,
      input.action,
      input.entityType,
      input.entityId ?? null,
      input.description,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ],
  );
}
