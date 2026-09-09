/**
 * Transport is priced by route/stop, never by class — deliberately
 * outside fee_structures (see fee_heads.basis note on that table).
 * Assigning a student to a stop computes a prorated charge from the
 * stop's annual fare and however many of the academic year's ten
 * months they're actually riding, and posts it as a real charge on
 * the enrollment's ledger — from there it behaves exactly like any
 * other charge (shows in the balance, gets paid, appears on receipts)
 * with zero special-casing anywhere else in the system.
 */

import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/index.js";
import { requireCapability, requireMember } from "../middleware/permissions.js";

export const transportRouter = Router();
transportRouter.use(requireMember);

const configGuard = requireCapability("manage_fee_structure");
const assignGuard = requireCapability("manage_admissions");

// ---------------------------------------------------------------------
// Bus routes
// ---------------------------------------------------------------------

const routeSchema = z.object({
  code: z.string().min(1).max(20),
  // Empty allowed deliberately: "Add Route" creates a stub with no name
  // yet, filled in inline right after — same pattern as fee heads and
  // sections created just-in-time elsewhere in this app.
  name: z.string().max(150).optional().default(""),
  distance_km: z.number().nonnegative().nullable().optional().default(null),
  vehicle_no: z.string().max(30).optional().default(""),
  driver_name: z.string().max(150).optional().default(""),
  driver_phone: z.string().max(20).optional().default(""),
  seats: z.number().int().positive().optional().default(40),
});

transportRouter.get("/routes", async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM bus_routes WHERE school_id = $1 AND is_active = true ORDER BY code`,
    [req.school!.id],
  );
  res.json(result.rows);
});

transportRouter.post("/routes", configGuard, async (req, res) => {
  const parsed = routeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ detail: parsed.error.issues[0]?.message });
  const d = parsed.data;
  try {
    const result = await pool.query(
      `INSERT INTO bus_routes (school_id, code, name, distance_km, vehicle_no, driver_name, driver_phone, seats)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [req.school!.id, d.code, d.name, d.distance_km, d.vehicle_no, d.driver_name, d.driver_phone, d.seats],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return res.status(409).json({ detail: "A route with that code already exists." });
    }
    throw err;
  }
});

const routeUpdateSchema = routeSchema.partial()
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update." });

transportRouter.patch("/routes/:id", configGuard, async (req, res) => {
  const parsed = routeUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ detail: parsed.error.issues[0]?.message });
  const fields = Object.keys(parsed.data);
  const setClause = fields.map((f, i) => `${f} = $${i + 3}`).join(", ");
  const result = await pool.query(
    `UPDATE bus_routes SET ${setClause} WHERE id = $1 AND school_id = $2 RETURNING *`,
    [String(req.params.id), req.school!.id, ...fields.map((f) => (parsed.data as any)[f])],
  );
  if (!result.rows[0]) return res.status(404).end();
  res.json(result.rows[0]);
});

transportRouter.delete("/routes/:id", configGuard, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM bus_routes WHERE id = $1 AND school_id = $2 RETURNING id`,
      [String(req.params.id), req.school!.id],
    );
    if (!result.rows[0]) return res.status(404).end();
    res.status(204).end();
  } catch (err) {
    // route_stops cascades from a route, but transport_fares and
    // transport_assignments RESTRICT deleting a stop — so a route that
    // has ever actually been priced or ridden refuses to delete here
    // too, the cascade hitting that restriction partway through.
    if ((err as { code?: string }).code === "23503") {
      return res.status(409).json({
        detail: "This route has stops that are priced or assigned to students, so it can't be deleted.",
      });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------
// Stops
// ---------------------------------------------------------------------

const stopSchema = z.object({
  // Empty allowed for the same reason as routes above — "Add stop"
  // creates a stub filled in inline right after.
  name: z.string().max(150).optional().default(""),
  sequence: z.number().int().positive().optional().default(1),
  pickup_time: z.string().nullable().optional().default(null),
});

transportRouter.get("/routes/:routeId/stops", async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM route_stops WHERE route_id = $1 AND school_id = $2 ORDER BY sequence, name`,
    [String(req.params.routeId), req.school!.id],
  );
  res.json(result.rows);
});

transportRouter.post("/routes/:routeId/stops", configGuard, async (req, res) => {
  const parsed = stopSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ detail: parsed.error.issues[0]?.message });
  const d = parsed.data;
  const route = await pool.query(
    `SELECT id FROM bus_routes WHERE id = $1 AND school_id = $2`,
    [String(req.params.routeId), req.school!.id],
  );
  if (!route.rows[0]) return res.status(404).json({ detail: "That route doesn't exist." });
  try {
    const result = await pool.query(
      `INSERT INTO route_stops (school_id, route_id, name, sequence, pickup_time)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.school!.id, req.params.routeId, d.name, d.sequence, d.pickup_time],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return res.status(409).json({ detail: "A stop with that name already exists on this route." });
    }
    throw err;
  }
});

const stopUpdateSchema = stopSchema.partial()
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update." });

transportRouter.patch("/stops/:id", configGuard, async (req, res) => {
  const parsed = stopUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ detail: parsed.error.issues[0]?.message });
  const fields = Object.keys(parsed.data);
  const setClause = fields.map((f, i) => `${f} = $${i + 3}`).join(", ");
  const result = await pool.query(
    `UPDATE route_stops SET ${setClause} WHERE id = $1 AND school_id = $2 RETURNING *`,
    [String(req.params.id), req.school!.id, ...fields.map((f) => (parsed.data as any)[f])],
  );
  if (!result.rows[0]) return res.status(404).end();
  res.json(result.rows[0]);
});

transportRouter.delete("/stops/:id", configGuard, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM route_stops WHERE id = $1 AND school_id = $2 RETURNING id`,
      [String(req.params.id), req.school!.id],
    );
    if (!result.rows[0]) return res.status(404).end();
    res.status(204).end();
  } catch (err) {
    if ((err as { code?: string }).code === "23503") {
      return res.status(409).json({
        detail: "This stop is already priced or assigned to a student, so it can't be deleted.",
      });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------
// Fares — the ANNUAL amount for a stop; assign() below prorates it
// ---------------------------------------------------------------------

const fareSchema = z.object({
  academic_year_id: z.string().uuid(),
  stop_id: z.string().uuid(),
  amount: z.number().int().nonnegative(), // paise, annual
  due_on: z.string(),
});

// Riders per stop for the year — the old localStorage screen showed
// this, and dropping it would be a visible regression, not just a
// missing nice-to-have.
transportRouter.get("/riders", async (req, res) => {
  const { academic_year_id } = req.query;
  if (!academic_year_id) return res.json([]);
  const result = await pool.query(
    `SELECT ta.stop_id, COUNT(*) AS riders
     FROM transport_assignments ta
     JOIN enrollments e ON e.id = ta.enrollment_id
     WHERE ta.school_id = $1 AND e.academic_year_id = $2 AND ta.ended_on IS NULL
     GROUP BY ta.stop_id`,
    [req.school!.id, academic_year_id],
  );
  res.json(result.rows.map((r) => ({ stop_id: r.stop_id, riders: Number(r.riders) })));
});

transportRouter.get("/fares", async (req, res) => {
  const { academic_year_id } = req.query;
  const params: unknown[] = [req.school!.id];
  let where = "tf.school_id = $1";
  if (academic_year_id) {
    params.push(academic_year_id);
    where += ` AND tf.academic_year_id = $${params.length}`;
  }
  const result = await pool.query(
    `SELECT tf.*, rs.name AS stop_name, br.code AS route_code, br.name AS route_name
     FROM transport_fares tf
     JOIN route_stops rs ON rs.id = tf.stop_id
     JOIN bus_routes br ON br.id = rs.route_id
     WHERE ${where} ORDER BY br.code, rs.sequence`,
    params,
  );
  res.json(result.rows);
});

transportRouter.post("/fares", configGuard, async (req, res) => {
  const parsed = fareSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ detail: parsed.error.issues[0]?.message });
  const d = parsed.data;
  try {
    const result = await pool.query(
      `INSERT INTO transport_fares (school_id, academic_year_id, stop_id, amount, term_no, due_on)
       VALUES ($1, $2, $3, $4, 1, $5) RETURNING *`,
      [req.school!.id, d.academic_year_id, d.stop_id, d.amount, d.due_on],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return res.status(409).json({ detail: "A fare is already set for this stop and year." });
    }
    throw err;
  }
});

const fareUpdateSchema = z.object({
  amount: z.number().int().nonnegative().optional(),
  due_on: z.string().optional(),
}).refine((v) => v.amount !== undefined || v.due_on !== undefined, { message: "Nothing to update." });

transportRouter.patch("/fares/:id", configGuard, async (req, res) => {
  const parsed = fareUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ detail: parsed.error.issues[0]?.message });
  const fields = Object.keys(parsed.data);
  const setClause = fields.map((f, i) => `${f} = $${i + 3}`).join(", ");
  const result = await pool.query(
    `UPDATE transport_fares SET ${setClause} WHERE id = $1 AND school_id = $2 RETURNING *`,
    [String(req.params.id), req.school!.id, ...fields.map((f) => (parsed.data as any)[f])],
  );
  if (!result.rows[0]) return res.status(404).end();
  res.json(result.rows[0]);
});

// ---------------------------------------------------------------------
// Assigning a student to a stop — the actual proration
// ---------------------------------------------------------------------

const ACADEMIC_YEAR_MONTHS = 10;

const assignSchema = z.object({
  stop_id: z.string().uuid(),
  months: z.number().int().min(1).max(ACADEMIC_YEAR_MONTHS),
  started_on: z.string().optional(),
});

transportRouter.get("/enrollments/:id/assignment", async (req, res) => {
  const result = await pool.query(
    `SELECT ta.*, rs.name AS stop_name, br.code AS route_code, br.name AS route_name
     FROM transport_assignments ta
     JOIN route_stops rs ON rs.id = ta.stop_id
     JOIN bus_routes br ON br.id = rs.route_id
     WHERE ta.enrollment_id = $1 AND ta.school_id = $2 AND ta.ended_on IS NULL
     ORDER BY ta.created_at DESC LIMIT 1`,
    [String(req.params.id), req.school!.id],
  );
  res.json(result.rows[0] || null);
});

transportRouter.post(
  "/enrollments/:id/assign", assignGuard,
  async (req, res) => {
    const parsed = assignSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ detail: parsed.error.issues[0]?.message });
    const d = parsed.data;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const enrollmentResult = await client.query(
        `SELECT id, academic_year_id FROM enrollments WHERE id = $1 AND school_id = $2 FOR UPDATE`,
        [req.params.id, req.school!.id],
      );
      const enrollment = enrollmentResult.rows[0];
      if (!enrollment) { await client.query("ROLLBACK"); return res.status(404).end(); }

      const fareResult = await client.query(
        `SELECT amount FROM transport_fares
         WHERE school_id = $1 AND academic_year_id = $2 AND stop_id = $3`,
        [req.school!.id, enrollment.academic_year_id, d.stop_id],
      );
      // Missing and explicitly-zero are treated the same — either way
      // the stop hasn't actually been priced yet, and assigning a
      // student to it would silently charge them nothing.
      if (!fareResult.rows[0] || Number(fareResult.rows[0].amount) === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ detail: "No fare has been set for this stop for this academic year yet." });
      }
      const annualFare = Number(fareResult.rows[0].amount);
      const proratedAmount = Math.round((annualFare / ACADEMIC_YEAR_MONTHS) * d.months);

      // Changing stop or months mid-year is a real, expected case (a
      // family moves, or extends from a few months to the rest of the
      // year) — end whatever assignment is currently active and reverse
      // its charge, same append-only reversal every other correction in
      // this system uses, rather than mutating either in place.
      const existing = await client.query(
        `SELECT id FROM transport_assignments
         WHERE enrollment_id = $1 AND school_id = $2 AND ended_on IS NULL FOR UPDATE`,
        [req.params.id, req.school!.id],
      );
      if (existing.rows[0]) {
        await client.query(
          `UPDATE transport_assignments SET ended_on = CURRENT_DATE WHERE id = $1`,
          [existing.rows[0].id],
        );
        const oldCharge = await client.query(
          `SELECT * FROM charges
           WHERE enrollment_id = $1 AND source = 'manual' AND reversed_by IS NULL
             AND head_name = 'Transport fee'
           ORDER BY created_at DESC LIMIT 1`,
          [req.params.id],
        );
        if (oldCharge.rows[0]) {
          const old = oldCharge.rows[0];
          const marker = await client.query(
            `INSERT INTO charges
               (school_id, enrollment_id, fee_head_id, head_name, amount, term_no, due_on,
                source, created_by)
             VALUES ($1, $2, $3, $4, 0, $5, $6, 'manual', $7) RETURNING id`,
            [req.school!.id, req.params.id, old.fee_head_id, old.head_name,
             old.term_no, old.due_on, req.user!.id],
          );
          await client.query(
            `UPDATE charges SET reversed_by = $1, reversal_reason = $2 WHERE id = $3`,
            [marker.rows[0].id, "Transport reassigned", old.id],
          );
        }
      }

      let transportHead = await client.query(
        `SELECT id FROM fee_heads WHERE school_id = $1 AND name = 'Transport fee'`,
        [req.school!.id],
      );
      if (!transportHead.rows[0]) {
        transportHead = await client.query(
          `INSERT INTO fee_heads (school_id, name, display_order) VALUES ($1, 'Transport fee', 99) RETURNING id`,
          [req.school!.id],
        );
      }

      const assignment = await client.query(
        `INSERT INTO transport_assignments (school_id, enrollment_id, stop_id, started_on, months)
         VALUES ($1, $2, $3, COALESCE($4, CURRENT_DATE), $5) RETURNING *`,
        [req.school!.id, req.params.id, d.stop_id, d.started_on || null, d.months],
      );

      const dueOn = d.started_on || new Date().toISOString().slice(0, 10);
      const charge = await client.query(
        `INSERT INTO charges
           (school_id, enrollment_id, fee_head_id, head_name, amount, term_no, due_on, source, created_by)
         VALUES ($1, $2, $3, 'Transport fee', $4, 1, $5, 'manual', $6) RETURNING *`,
        [req.school!.id, req.params.id, transportHead.rows[0].id, proratedAmount, dueOn, req.user!.id],
      );

      await client.query("COMMIT");
      res.status(201).json({ assignment: assignment.rows[0], charge: charge.rows[0], annual_fare: annualFare });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  },
);

transportRouter.post(
  "/assignments/:id/end", assignGuard,
  async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const assignment = await client.query(
        `SELECT * FROM transport_assignments WHERE id = $1 AND school_id = $2 FOR UPDATE`,
        [req.params.id, req.school!.id],
      );
      const row = assignment.rows[0];
      if (!row) { await client.query("ROLLBACK"); return res.status(404).end(); }
      if (row.ended_on) {
        await client.query("ROLLBACK");
        return res.status(400).json({ detail: "That assignment has already ended." });
      }

      await client.query(
        `UPDATE transport_assignments SET ended_on = CURRENT_DATE WHERE id = $1`, [row.id],
      );

      const oldCharge = await client.query(
        `SELECT * FROM charges
         WHERE enrollment_id = $1 AND source = 'manual' AND reversed_by IS NULL AND head_name = 'Transport fee'
         ORDER BY created_at DESC LIMIT 1`,
        [row.enrollment_id],
      );
      if (oldCharge.rows[0]) {
        const old = oldCharge.rows[0];
        const marker = await client.query(
          `INSERT INTO charges
             (school_id, enrollment_id, fee_head_id, head_name, amount, term_no, due_on, source, created_by)
           VALUES ($1, $2, $3, $4, 0, $5, $6, 'manual', $7) RETURNING id`,
          [req.school!.id, row.enrollment_id, old.fee_head_id, old.head_name,
           old.term_no, old.due_on, req.user!.id],
        );
        await client.query(
          `UPDATE charges SET reversed_by = $1, reversal_reason = $2 WHERE id = $3`,
          [marker.rows[0].id, "Transport assignment ended", old.id],
        );
      }

      await client.query("COMMIT");
      res.status(204).end();
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  },
);
