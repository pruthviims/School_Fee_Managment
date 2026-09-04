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
