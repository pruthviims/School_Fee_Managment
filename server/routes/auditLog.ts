import { Router } from "express";
import { pool } from "../db/index.js";
import { requireCapability } from "../middleware/permissions.js";

export const auditLogRouter = Router();

auditLogRouter.get("/", requireCapability("view_audit_log"), async (req, res) => {
  const { entity_type, user_id, from, to, q } = req.query;
  const params: unknown[] = [req.school!.id];
  let where = "school_id = $1";

  if (entity_type) {
    params.push(String(entity_type));
    where += ` AND entity_type = $${params.length}`;
  }
  if (user_id) {
    params.push(String(user_id));
    where += ` AND user_id = $${params.length}`;
  }
  if (from) {
    params.push(String(from));
    where += ` AND created_at >= $${params.length}`;
  }
  if (to) {
    params.push(String(to));
    where += ` AND created_at <= $${params.length}::date + interval '1 day'`;
  }
  if (q) {
    params.push(`%${String(q)}%`);
    where += ` AND (description ILIKE $${params.length} OR user_name ILIKE $${params.length})`;
  }

  const result = await pool.query(
    `SELECT * FROM audit_log WHERE ${where} ORDER BY created_at DESC LIMIT 500`,
    params,
  );
  res.json(result.rows);
});
