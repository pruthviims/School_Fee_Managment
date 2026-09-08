/**
 * Runs on every request. Reads the session cookie, loads the user, and
 * resolves their active Membership (and therefore which school this
 * request acts on) — the direct port of
 * backend/fees/middleware.py::TenantMiddleware.
 *
 * A user with no active membership for any school gets req.user set but
 * req.membership / req.school left null, so a subsequent
 * requireCapability check denies them by construction rather than
 * needing a separate "does this person have access" check everywhere.
 */

import type { NextFunction, Request, Response } from "express";
import { pool } from "../db/index.js";
import { verifySessionToken } from "../services/authService.js";

const SESSION_COOKIE = "session";

export async function attachAuth(req: Request, _res: Response, next: NextFunction) {
  req.user = null;
  req.membership = null;
  req.school = null;

  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return next();

  const payload = verifySessionToken(token);
  if (!payload) return next();

  const userResult = await pool.query(
    `SELECT id, email, full_name, is_active, password_hash
     FROM users WHERE id = $1`,
    [payload.sub],
  );
  const user = userResult.rows[0];
  if (!user || !user.is_active) return next();
  req.user = user;

  const membershipResult = await pool.query(
    `SELECT m.id, m.role, m.is_active,
            s.id AS school_id, s.name, s.short_code, s.address,
            s.logo_key, s.logo_data_url, s.receipt_footer, s.is_active AS school_is_active
     FROM memberships m
     JOIN schools s ON s.id = m.school_id
     WHERE m.user_id = $1 AND m.is_active = true AND s.is_active = true
     ORDER BY m.created_at ASC
     LIMIT 1`,
    [user.id],
  );
  const row = membershipResult.rows[0];
  if (row) {
    req.membership = { id: row.id, role: row.role, is_active: row.is_active };
    req.school = {
      id: row.school_id, name: row.name, short_code: row.short_code,
      address: row.address, logo_key: row.logo_key, logo_data_url: row.logo_data_url,
      receipt_footer: row.receipt_footer, is_active: row.school_is_active,
    };
  }

  next();
}

export { SESSION_COOKIE };
