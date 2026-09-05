/**
 * Admission is creating a Student (permanent identity) and an Enrollment
 * (that student in this academic year) together, then snapshotting the
 * fee structure onto the enrollment via billing.generateCharges — see
 * server/services/billing.ts for why charges are a snapshot, not a live
 * reference to fee_structures.
 */

import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/index.js";
import { requireCapability, requireMember } from "../middleware/permissions.js";
import { BillingError, generateCharges } from "../services/billing.js";
import { getEnrollmentLedger } from "../services/ledger.js";

export const studentsRouter = Router();
studentsRouter.use(requireMember);

const admitSchema = z.object({
  admission_no: z.string().min(1).max(30),
  full_name: z.string().min(1).max(150),
  date_of_birth: z.string().nullable().optional(),
  gender: z.string().max(20).optional().default(""),
  guardian_name: z.string().max(150).optional().default(""),
  guardian_phone: z.string().max(20).optional().default(""),
  guardian_email: z.string().email().optional().or(z.literal("")).default(""),
  address: z.string().optional().default(""),
  academic_year_id: z.string().uuid(),
  class_level_id: z.string().uuid(),
  section_id: z.string().uuid(),
  stream_id: z.string().uuid().nullable().optional().default(null),
  admission_type: z.enum(["new", "carry_over", "repeat", "readmission"]).optional().default("new"),
  optional_head_ids: z.array(z.string().uuid()).optional().default([]),
});

studentsRouter.post("/admit", requireCapability("manage_admissions"), async (req, res) => {
  const parsed = admitSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ detail: parsed.error.issues[0]?.message });
  const d = parsed.data;

  const client = await pool.connect();
  let student, enrollment;
  try {
    await client.query("BEGIN");

    try {
      const studentResult = await client.query(
        `INSERT INTO students
           (school_id, admission_no, full_name, date_of_birth, gender, admitted_on,
            guardian_name, guardian_phone, guardian_email, address, created_by)
         VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, $6, $7, $8, $9, $10)
         RETURNING *`,
        [req.school!.id, d.admission_no, d.full_name, d.date_of_birth ?? null, d.gender,
         d.guardian_name, d.guardian_phone, d.guardian_email, d.address, req.user!.id],
      );
      student = studentResult.rows[0];
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        await client.query("ROLLBACK");
        return res.status(409).json({ detail: "That admission number is already in use." });
      }
      throw err;
    }

    const enrollmentResult = await client.query(
      `INSERT INTO enrollments
         (school_id, student_id, academic_year_id, class_level_id, section_id, stream_id,
          admission_type, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [req.school!.id, student.id, d.academic_year_id, d.class_level_id, d.section_id,
       d.stream_id, d.admission_type, req.user!.id],
    );
    enrollment = enrollmentResult.rows[0];

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // generateCharges opens its own transaction — deliberately separate from
  // the one above, so a charge-generation failure (e.g. no fee structure
  // configured for this class yet) doesn't also roll back the admission
  // itself; the office can fix the fee structure and post charges after.
  try {
    const charges = await generateCharges(enrollment.id, {
      optionalHeadIds: d.optional_head_ids, createdBy: req.user!.id,
    });
    res.status(201).json({ student, enrollment, charges });
  } catch (err) {
    if (err instanceof BillingError) {
      return res.status(201).json({
        student, enrollment, charges: [],
        warning: `Admitted, but charges weren't generated: ${err.message}`,
      });
    }
    throw err;
  }
});

studentsRouter.get("/enrollments/:id/ledger", async (req, res) => {
  const enrollment = await pool.query(
    `SELECT id FROM enrollments WHERE id = $1 AND school_id = $2`,
    [req.params.id, req.school!.id],
  );
  if (!enrollment.rows[0]) return res.status(404).end();

  const ledger = await getEnrollmentLedger(req.params.id);
  res.json(ledger);
});

const enrollmentUpdateSchema = z.object({
  section_id: z.string().uuid().optional(),
  stream_id: z.string().uuid().nullable().optional(),
  roll_no: z.number().int().positive().nullable().optional(),
}).refine((v) => Object.keys(v).length > 0, { message: "Nothing to update." });

studentsRouter.patch(
  "/enrollments/:id", requireCapability("manage_admissions"),
  async (req, res) => {
    const parsed = enrollmentUpdateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ detail: parsed.error.issues[0]?.message });

    const fields = Object.keys(parsed.data);
    const setClause = fields.map((f, i) => `${f} = $${i + 3}`).join(", ");
    try {
      const result = await pool.query(
        `UPDATE enrollments SET ${setClause} WHERE id = $1 AND school_id = $2 RETURNING *`,
        [req.params.id, req.school!.id, ...fields.map((f) => (parsed.data as any)[f])],
      );
      if (!result.rows[0]) return res.status(404).end();
      res.json(result.rows[0]);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        return res.status(409).json({ detail: "That roll number is already used in this section." });
      }
      throw err;
    }
  },
);

// ---------------------------------------------------------------------
// Concessions — an append-only ledger, same as charges and payments.
// Reversing one never deletes or edits the original: a new, zero-amount
// row is created, and the original's reversed_by is pointed at it, so
// both the grant and its reversal stay visible to an auditor. Gated
// under manage_concessions (accountant/owner), not manage_admissions —
// front desk can admit a student and collect a payment, but approving a
// fee waiver is a different, deliberately narrower kind of decision.
// ---------------------------------------------------------------------

const concessionSchema = z.object({
  amount: z.number().int().positive(), // paise — the computed rupee amount, not a percentage
  reason: z.enum(["sibling", "staff_ward", "rte", "merit", "hardship", "other"]),
  note: z.string().max(500).optional().default(""),
  fee_head_id: z.string().uuid().nullable().optional().default(null),
  is_government_reimbursed: z.boolean().optional().default(false),
});

studentsRouter.get("/enrollments/:id/concessions", async (req, res) => {
  const result = await pool.query(
    `SELECT c.*, u.full_name AS approved_by_name, u.email AS approved_by_email
     FROM concessions c LEFT JOIN users u ON u.id = c.approved_by
     WHERE c.enrollment_id = $1 AND c.school_id = $2
     ORDER BY c.created_at DESC`,
    [req.params.id, req.school!.id],
  );
  res.json(result.rows);
});

studentsRouter.post(
  "/enrollments/:id/concessions", requireCapability("manage_concessions"),
  async (req, res) => {
    const parsed = concessionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ detail: parsed.error.issues[0]?.message });
    const d = parsed.data;

    const enrollment = await pool.query(
      `SELECT id FROM enrollments WHERE id = $1 AND school_id = $2`,
      [req.params.id, req.school!.id],
    );
    if (!enrollment.rows[0]) return res.status(404).end();

    const result = await pool.query(
      `INSERT INTO concessions
         (school_id, enrollment_id, fee_head_id, reason, note, amount,
          is_government_reimbursed, approved_by, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING *`,
      [req.school!.id, req.params.id, d.fee_head_id, d.reason, d.note, d.amount,
       d.is_government_reimbursed, req.user!.id],
    );
    res.status(201).json(result.rows[0]);
  },
);

const reverseConcessionSchema = z.object({
  reason: z.string().max(500).optional().default("Reversed"),
});

studentsRouter.post(
  "/concessions/:id/reverse", requireCapability("manage_concessions"),
  async (req, res) => {
    const parsed = reverseConcessionSchema.safeParse(req.body ?? {});
    const reason = parsed.success ? parsed.data.reason : "Reversed";

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const original = await client.query(
        `SELECT * FROM concessions WHERE id = $1 AND school_id = $2 FOR UPDATE`,
        [req.params.id, req.school!.id],
      );
      const row = original.rows[0];
      if (!row) { await client.query("ROLLBACK"); return res.status(404).end(); }
      if (row.reversed_by) {
        await client.query("ROLLBACK");
        return res.status(400).json({ detail: "That concession has already been reversed." });
      }

      const marker = await client.query(
        `INSERT INTO concessions
           (school_id, enrollment_id, fee_head_id, reason, note, amount, approved_by, created_by)
         VALUES ($1, $2, $3, $4, $5, 0, $6, $6) RETURNING id`,
        [req.school!.id, row.enrollment_id, row.fee_head_id, row.reason,
         `Reversal of ${row.id}: ${reason}`, req.user!.id],
      );
      await client.query(
        `UPDATE concessions SET reversed_by = $1, reversal_reason = $2 WHERE id = $3`,
        [marker.rows[0].id, reason, row.id],
      );
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

studentsRouter.get("/enrollments", async (req, res) => {
  const { academic_year_id, class_level_id, section_id } = req.query;
  const params: unknown[] = [req.school!.id];
  let where = "e.school_id = $1 AND e.is_active = true";
  if (academic_year_id) { params.push(academic_year_id); where += ` AND e.academic_year_id = $${params.length}`; }
  if (class_level_id) { params.push(class_level_id); where += ` AND e.class_level_id = $${params.length}`; }
  if (section_id) { params.push(section_id); where += ` AND e.section_id = $${params.length}`; }

  const result = await pool.query(
    `SELECT e.id, e.admission_type, e.outcome, e.roll_no,
            s.admission_no, s.full_name,
            cl.name AS class_name, sec.name AS section_name
     FROM enrollments e
     JOIN students s ON s.id = e.student_id
     JOIN class_levels cl ON cl.id = e.class_level_id
     JOIN sections sec ON sec.id = e.section_id
     WHERE ${where}
     ORDER BY cl.ladder_order, sec.name, s.full_name`,
    params,
  );
  res.json(result.rows);
});
