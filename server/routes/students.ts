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
import { logActivity } from "../services/auditLog.js";
import { BillingError, generateCharges } from "../services/billing.js";
import { fiscalYearFor, issueDocumentNumber } from "../services/documentCounter.js";
import { getEnrollmentLedger } from "../services/ledger.js";

export const studentsRouter = Router();
studentsRouter.use(requireMember);

const admitSchema = z.object({
  admission_no: z.string().min(1).max(30),
  full_name: z.string().min(1).max(150),
  date_of_birth: z.string().nullable().optional(),
  gender: z.enum(["male", "female", "other"]),
  blood_group: z.string().max(10).optional().default(""),
  contact_type: z.enum(["parents", "guardian"]).optional().default("guardian"),
  father_name: z.string().max(150).optional().default(""),
  father_phone: z.string().max(20).optional().default(""),
  father_email: z.string().email().optional().or(z.literal("")).default(""),
  mother_name: z.string().max(150).optional().default(""),
  mother_phone: z.string().max(20).optional().default(""),
  mother_email: z.string().email().optional().or(z.literal("")).default(""),
  guardian_relationship: z.string().max(50).optional().default(""),
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
}).refine(
  (v) => v.contact_type === "guardian"
    ? Boolean(v.guardian_relationship.trim() && v.guardian_name.trim())
    : Boolean(v.father_name.trim() && v.mother_name.trim()),
  {
    message: "For Parents, both Father's and Mother's name are required. " +
      "For a Guardian, their relationship to the student and name are required.",
  },
);

studentsRouter.post("/admit", requireCapability("manage_admissions"), async (req, res) => {
  const parsed = admitSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ detail: parsed.error.issues[0]?.message });
  const d = parsed.data;

  // Refuses admission into a class whose fees haven't actually been set
  // up yet — every fee_structure line for it is missing or explicitly
  // zero. Without this, a class the office simply hasn't priced yet
  // silently admits students for free, which is far more likely a
  // forgotten setup step than an intentional zero-fee class.
  const priced = await pool.query(
    `SELECT 1 FROM fee_structures
     WHERE school_id = $1 AND academic_year_id = $2 AND class_level_id = $3 AND amount > 0
     LIMIT 1`,
    [req.school!.id, d.academic_year_id, d.class_level_id],
  );
  if (!priced.rows[0]) {
    return res.status(400).json({
      detail: "This class has no fees set up yet for this academic year. Set up Fee Structure for it first.",
    });
  }

  // guardian_name/phone/email stay the single "primary contact" every
  // existing screen already reads (Fee Collection's table, receipts,
  // the TC certificate) — for Parents, populated from whichever parent
  // is actually reachable, so nothing downstream needs to learn a new
  // shape just to keep working. Father is checked first only as a
  // deterministic tie-break when both are filled in, not a statement
  // about who the "real" contact is.
  const primaryName = d.contact_type === "guardian" ? d.guardian_name
    : (d.father_name || d.mother_name);
  const primaryPhone = d.contact_type === "guardian" ? d.guardian_phone
    : (d.father_phone || d.mother_phone);
  const primaryEmail = d.contact_type === "guardian" ? d.guardian_email
    : (d.father_email || d.mother_email);

  const client = await pool.connect();
  let student, enrollment;
  try {
    await client.query("BEGIN");

    try {
      const studentResult = await client.query(
        `INSERT INTO students
           (school_id, admission_no, full_name, date_of_birth, gender, blood_group, admitted_on,
            contact_type, father_name, father_phone, father_email,
            mother_name, mother_phone, mother_email, guardian_relationship,
            guardian_name, guardian_phone, guardian_email, address, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, CURRENT_DATE, $7, $8, $9, $10, $11, $12, $13, $14,
                 $15, $16, $17, $18, $19)
         RETURNING *`,
        [req.school!.id, d.admission_no, d.full_name, d.date_of_birth ?? null, d.gender, d.blood_group,
         d.contact_type, d.father_name, d.father_phone, d.father_email,
         d.mother_name, d.mother_phone, d.mother_email, d.guardian_relationship,
         primaryName, primaryPhone, primaryEmail, d.address, req.user!.id],
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

    await logActivity(client, req, {
      action: "student.admit",
      entityType: "student",
      entityId: student.id,
      description: `Admitted ${student.full_name} (admission no. ${student.admission_no})`,
      metadata: { enrollment_id: enrollment.id, class_level_id: d.class_level_id, section_id: d.section_id },
    });

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

// Everything the Student Profile screen needs in one call: the
// student's own record (name, contact details — the editable fields),
// plus this enrollment's class/section, rather than the frontend
// piecing it together from the flat enrollments list it already has
// for other screens.
studentsRouter.get("/enrollments/:id/profile", async (req, res) => {
  const result = await pool.query(
    `SELECT s.id AS student_id, s.admission_no, s.full_name, s.date_of_birth, s.gender,
            s.blood_group, s.contact_type,
            s.father_name, s.father_phone, s.father_email,
            s.mother_name, s.mother_phone, s.mother_email, s.guardian_relationship,
            s.guardian_name, s.guardian_phone, s.guardian_email, s.address, s.status,
            e.id AS enrollment_id, e.academic_year_id, e.class_level_id, e.section_id,
            e.outcome, e.is_active, e.withdrawn_on, e.withdrawal_reason,
            cl.name AS class_name, sec.name AS section_name
     FROM enrollments e
     JOIN students s ON s.id = e.student_id
     JOIN class_levels cl ON cl.id = e.class_level_id
     JOIN sections sec ON sec.id = e.section_id
     WHERE e.id = $1 AND e.school_id = $2`,
    [req.params.id, req.school!.id],
  );
  if (!result.rows[0]) return res.status(404).end();
  res.json(result.rows[0]);
});

const studentUpdateSchema = z.object({
  guardian_name: z.string().max(150).optional(),
  guardian_phone: z.string().max(20).optional(),
  guardian_email: z.string().max(150).optional(),
  address: z.string().max(500).optional(),
  gender: z.enum(["male", "female", "other"]).optional(),
  blood_group: z.string().max(10).optional(),
  contact_type: z.enum(["parents", "guardian"]).optional(),
  father_name: z.string().max(150).optional(),
  father_phone: z.string().max(20).optional(),
  father_email: z.string().max(150).optional(),
  mother_name: z.string().max(150).optional(),
  mother_phone: z.string().max(20).optional(),
  mother_email: z.string().max(150).optional(),
  guardian_relationship: z.string().max(50).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: "Nothing to update." });

// Deliberately narrow on identity: full name and admission number
// aren't editable here — those are treated as fixed identity records
// elsewhere in this app (matching how a receipt freezes a student's
// name at the time it's issued). Gender and blood group, by contrast,
// genuinely can be entered wrong and corrected later — required at
// admission doesn't mean frozen forever — so both are writable here.
studentsRouter.patch(
  "/:id", requireCapability("manage_admissions"),
  async (req, res) => {
    const parsed = studentUpdateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ detail: parsed.error.issues[0]?.message });

    const before = await pool.query(
      `SELECT guardian_name, guardian_phone, guardian_email, address, gender, blood_group,
              contact_type, father_name, mother_name, guardian_relationship
       FROM students WHERE id = $1 AND school_id = $2`,
      [req.params.id, req.school!.id],
    );
    if (!before.rows[0]) return res.status(404).end();

    const data: Record<string, unknown> = { ...parsed.data };
    // The primary contact (guardian_name/phone/email — what every other
    // screen actually reads) is only recomputed when contact_type is
    // part of this same request, on the assumption the caller sends the
    // whole family block together when editing it, not one field in
    // isolation — the same assumption the New Admission form's own
    // submit already makes.
    if (data.contact_type) {
      const isGuardian = data.contact_type === "guardian";
      data.guardian_name = isGuardian
        ? (data.guardian_name as string ?? "")
        : ((data.father_name as string) || (data.mother_name as string) || "");
      data.guardian_phone = isGuardian
        ? (data.guardian_phone as string ?? "")
        : ((data.father_phone as string) || (data.mother_phone as string) || "");
      data.guardian_email = isGuardian
        ? (data.guardian_email as string ?? "")
        : ((data.father_email as string) || (data.mother_email as string) || "");
    }

    const fields = Object.keys(data);
    const setClause = fields.map((f, i) => `${f} = $${i + 3}`).join(", ");
    const result = await pool.query(
      `UPDATE students SET ${setClause} WHERE id = $1 AND school_id = $2 RETURNING *`,
      [req.params.id, req.school!.id, ...fields.map((f) => data[f])],
    );

    await logActivity(pool, req, {
      action: "student.update",
      entityType: "student",
      entityId: String(req.params.id),
      description: `Updated ${result.rows[0].full_name}'s details (${fields.join(", ")})`,
      metadata: { before: before.rows[0], after: parsed.data },
    });

    res.json(result.rows[0]);
  },
);

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

      if (parsed.data.section_id !== undefined) {
        await logActivity(pool, req, {
          action: "enrollment.section_change",
          entityType: "enrollment",
          entityId: String(req.params.id),
          description: "Changed the student's section",
          metadata: { section_id: parsed.data.section_id },
        });
      }

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
// Withdrawal and refunds — a student stops attending mid-year (a
// parent's death, a transfer to another school) and the amount to
// refund is management's own decision, not derived from the ledger
// (confirmed: free-form, not capped to any calculated credit). These
// are two genuinely independent actions, not one combined step: a
// school might withdraw a student with nothing owed back, or refund an
// amount without formally withdrawing (correcting an earlier mistake).
// ---------------------------------------------------------------------

const withdrawSchema = z.object({
  withdrawn_on: z.string(),
  reason: z.string().max(500).optional().default(""),
});

studentsRouter.post(
  "/enrollments/:id/withdraw", requireCapability("manage_admissions"),
  async (req, res) => {
    const parsed = withdrawSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ detail: parsed.error.issues[0]?.message });
    const d = parsed.data;

    const result = await pool.query(
      `UPDATE enrollments
       SET outcome = 'left', is_active = false, withdrawn_on = $1, withdrawal_reason = $2
       WHERE id = $3 AND school_id = $4 RETURNING *`,
      [d.withdrawn_on, d.reason, req.params.id, req.school!.id],
    );
    if (!result.rows[0]) return res.status(404).end();

    const student = await pool.query(`SELECT full_name FROM students WHERE id = $1`,
      [result.rows[0].student_id]);
    await logActivity(pool, req, {
      action: "enrollment.withdraw",
      entityType: "enrollment",
      entityId: String(req.params.id),
      description: `Withdrew ${student.rows[0]?.full_name || "a student"}${d.reason ? ` — ${d.reason}` : ""}`,
      metadata: { withdrawn_on: d.withdrawn_on, reason: d.reason },
    });

    res.json(result.rows[0]);
  },
);

const refundSchema = z.object({
  amount: z.number().int().positive(), // paise — management's own figure, not tied to the ledger
  mode: z.enum(["cash", "upi", "card", "netbanking", "neft", "cheque", "dd"]),
  instrument_ref: z.string().max(100).optional().default(""),
  reason: z.string().max(500).optional().default(""),
  approver_name: z.string().max(150).optional().default(""),
});

// Accountant/Owner only (void_payments) — a refund is money leaving the
// school, the same sensitivity level already agreed for voiding a
// payment, not something Front Desk initiates on their own.
studentsRouter.post(
  "/enrollments/:id/refund", requireCapability("void_payments"),
  async (req, res) => {
    const parsed = refundSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ detail: parsed.error.issues[0]?.message });
    const d = parsed.data;

    const enrollment = await pool.query(
      `SELECT e.id, s.full_name FROM enrollments e JOIN students s ON s.id = e.student_id
       WHERE e.id = $1 AND e.school_id = $2`,
      [req.params.id, req.school!.id],
    );
    if (!enrollment.rows[0]) return res.status(404).end();

    const result = await pool.query(
      `INSERT INTO refunds
         (school_id, enrollment_id, amount, mode, instrument_ref, reason, approver_name, refunded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [req.school!.id, req.params.id, d.amount, d.mode, d.instrument_ref, d.reason,
       d.approver_name, req.user!.id],
    );

    await logActivity(pool, req, {
      action: "refund.create",
      entityType: "refund",
      entityId: result.rows[0].id,
      description: `Refunded ${enrollment.rows[0].full_name} — ₹${(d.amount / 100).toFixed(2)} via ${d.mode}`,
      metadata: { amount: d.amount, mode: d.mode, reason: d.reason },
    });

    res.status(201).json(result.rows[0]);
  },
);

studentsRouter.get("/enrollments/:id/refunds", async (req, res) => {
  const result = await pool.query(
    `SELECT r.*, u.full_name AS refunded_by_name FROM refunds r
     LEFT JOIN users u ON u.id = r.refunded_by
     WHERE r.enrollment_id = $1 AND r.school_id = $2
     ORDER BY r.created_at DESC`,
    [req.params.id, req.school!.id],
  );
  res.json(result.rows);
});

// ---------------------------------------------------------------------
// TC (Transfer Certificate) — every student leaving, for any reason,
// goes through this same three-stage process: pending_clearance ->
// cleared -> issued. Accountant/Owner can complete both the clearance
// and issue steps alone (manage_tc covers both) — this isn't a hard
// two-person requirement, but the two steps still get their own actor
// and timestamp each, even when it's the same person doing both back
// to back, so there's always a real record of when dues were actually
// checked versus when the certificate was actually issued.
// ---------------------------------------------------------------------

const tcRequestSchema = z.object({
  reason: z.string().max(500),
  last_day: z.string(),
});

studentsRouter.post(
  "/enrollments/:id/tc-requests", requireCapability("manage_admissions"),
  async (req, res) => {
    const parsed = tcRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ detail: parsed.error.issues[0]?.message });
    const d = parsed.data;

    const existing = await pool.query(
      `SELECT id FROM tc_requests WHERE enrollment_id = $1 AND status != 'issued'`,
      [req.params.id],
    );
    if (existing.rows[0]) {
      return res.status(409).json({ detail: "A TC request is already in progress for this student." });
    }

    const result = await pool.query(
      `INSERT INTO tc_requests (school_id, enrollment_id, reason, last_day, requested_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.school!.id, req.params.id, d.reason, d.last_day, req.user!.id],
    );

    const student = await pool.query(
      `SELECT s.full_name FROM enrollments e JOIN students s ON s.id = e.student_id WHERE e.id = $1`,
      [req.params.id],
    );
    await logActivity(pool, req, {
      action: "tc.request",
      entityType: "tc_request",
      entityId: result.rows[0].id,
      description: `Requested a TC for ${student.rows[0]?.full_name || "a student"} — ${d.reason}`,
      metadata: { last_day: d.last_day, reason: d.reason },
    });

    res.status(201).json(result.rows[0]);
  },
);

studentsRouter.get("/enrollments/:id/tc-requests", async (req, res) => {
  const result = await pool.query(
    `SELECT tr.*, req.full_name AS requested_by_name, clr.full_name AS cleared_by_name,
            iss.full_name AS issued_by_name
     FROM tc_requests tr
     LEFT JOIN users req ON req.id = tr.requested_by
     LEFT JOIN users clr ON clr.id = tr.cleared_by
     LEFT JOIN users iss ON iss.id = tr.issued_by
     WHERE tr.enrollment_id = $1 AND tr.school_id = $2
     ORDER BY tr.requested_on DESC`,
    [req.params.id, req.school!.id],
  );
  res.json(result.rows);
});

const tcClearSchema = z.object({ clearance_note: z.string().max(500).optional().default("") });

studentsRouter.post(
  "/tc-requests/:id/clear", requireCapability("manage_tc"),
  async (req, res) => {
    const parsed = tcClearSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ detail: parsed.error.issues[0]?.message });

    const current = await pool.query(
      `SELECT status FROM tc_requests WHERE id = $1 AND school_id = $2`,
      [req.params.id, req.school!.id],
    );
    if (!current.rows[0]) return res.status(404).end();
    if (current.rows[0].status !== "pending_clearance") {
      return res.status(400).json({ detail: "This request has already been cleared or issued." });
    }

    const result = await pool.query(
      `UPDATE tc_requests
       SET status = 'cleared', clearance_note = $1, cleared_by = $2, cleared_on = now()
       WHERE id = $3 RETURNING *`,
      [parsed.data.clearance_note, req.user!.id, req.params.id],
    );

    await logActivity(pool, req, {
      action: "tc.clear",
      entityType: "tc_request",
      entityId: String(req.params.id),
      description: `Gave finance clearance for a TC — ${parsed.data.clearance_note || "no dues outstanding"}`,
      metadata: { clearance_note: parsed.data.clearance_note },
    });

    res.json(result.rows[0]);
  },
);

const tcIssueSchema = z.object({
  conduct: z.string().max(200).optional().default(""),
  qualified_for_promotion: z.boolean().optional(),
  remarks: z.string().max(500).optional().default(""),
});

studentsRouter.post(
  "/tc-requests/:id/issue", requireCapability("manage_tc"),
  async (req, res) => {
    const parsed = tcIssueSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ detail: parsed.error.issues[0]?.message });
    const d = parsed.data;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const current = await client.query(
        `SELECT * FROM tc_requests WHERE id = $1 AND school_id = $2 FOR UPDATE`,
        [req.params.id, req.school!.id],
      );
      const request = current.rows[0];
      if (!request) { await client.query("ROLLBACK"); return res.status(404).end(); }
      if (request.status !== "cleared") {
        await client.query("ROLLBACK");
        return res.status(400).json({ detail: "This request needs finance clearance before it can be issued." });
      }

      const fiscalYear = fiscalYearFor(new Date());
      const tcNumber = await issueDocumentNumber(client, {
        schoolId: req.school!.id, docType: "tc", fiscalYear, prefix: "TC/",
      });

      const updated = await client.query(
        `UPDATE tc_requests
         SET status = 'issued', tc_number = $1, conduct = $2, qualified_for_promotion = $3,
             remarks = $4, issued_by = $5, issued_on = now()
         WHERE id = $6 RETURNING *`,
        [tcNumber, d.conduct, d.qualified_for_promotion ?? null, d.remarks, req.user!.id, req.params.id],
      );

      await client.query(
        `UPDATE enrollments
         SET outcome = 'tc_issued', is_active = false, withdrawn_on = $1, withdrawal_reason = $2
         WHERE id = $3`,
        [request.last_day, request.reason, request.enrollment_id],
      );

      await client.query("COMMIT");

      const student = await pool.query(
        `SELECT s.full_name FROM enrollments e JOIN students s ON s.id = e.student_id WHERE e.id = $1`,
        [request.enrollment_id],
      );
      await logActivity(pool, req, {
        action: "tc.issue",
        entityType: "tc_request",
        entityId: String(req.params.id),
        description: `Issued TC ${tcNumber} for ${student.rows[0]?.full_name || "a student"}`,
        metadata: { tc_number: tcNumber, conduct: d.conduct },
      });

      res.json(updated.rows[0]);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  },
);

studentsRouter.get("/tc-requests/:id/document-data", async (req, res) => {
  const result = await pool.query(
    `SELECT tr.*, s.full_name, s.admission_no, s.date_of_birth, s.guardian_name,
            e.academic_year_id, cl.name AS class_name, sc.name AS school_name,
            sc.address AS school_address, sc.logo_data_url,
            ay.name AS academic_year_name
     FROM tc_requests tr
     JOIN enrollments e ON e.id = tr.enrollment_id
     JOIN students s ON s.id = e.student_id
     JOIN class_levels cl ON cl.id = e.class_level_id
     JOIN academic_years ay ON ay.id = e.academic_year_id
     JOIN schools sc ON sc.id = tr.school_id
     WHERE tr.id = $1 AND tr.school_id = $2`,
    [req.params.id, req.school!.id],
  );
  if (!result.rows[0]) return res.status(404).end();
  if (result.rows[0].status !== "issued") {
    return res.status(400).json({ detail: "This TC hasn't been issued yet." });
  }
  res.json(result.rows[0]);
});

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
  approver_name: z.string().max(150).optional().default(""),
});

studentsRouter.get("/enrollments/:id/concessions", async (req, res) => {
  const result = await pool.query(
    `SELECT c.*, u.full_name AS recorded_by_name, u.email AS recorded_by_email
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
          is_government_reimbursed, approver_name, approved_by, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING *`,
      [req.school!.id, req.params.id, d.fee_head_id, d.reason, d.note, d.amount,
       d.is_government_reimbursed, d.approver_name, req.user!.id],
    );

    const student = await pool.query(
      `SELECT s.full_name FROM enrollments e JOIN students s ON s.id = e.student_id WHERE e.id = $1`,
      [req.params.id],
    );
    await logActivity(pool, req, {
      action: "concession.grant",
      entityType: "concession",
      entityId: result.rows[0].id,
      description: `Granted a concession of ₹${(d.amount / 100).toFixed(2)} to ` +
        `${student.rows[0]?.full_name || "a student"}${d.fee_head_id ? " (transport)" : ""}`,
      metadata: { amount: d.amount, reason: d.reason, fee_head_id: d.fee_head_id },
    });

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

      const student = await pool.query(
        `SELECT s.full_name FROM enrollments e JOIN students s ON s.id = e.student_id WHERE e.id = $1`,
        [row.enrollment_id],
      );
      await logActivity(pool, req, {
        action: "concession.reverse",
        entityType: "concession",
        entityId: String(req.params.id),
        description: `Reversed a ₹${(row.amount / 100).toFixed(2)} concession for ` +
          `${student.rows[0]?.full_name || "a student"} — ${reason}`,
        metadata: { amount: row.amount, reason },
      });

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
  const { academic_year_id, class_level_id, section_id, include_ledger } = req.query;
  const params: unknown[] = [req.school!.id];
  let where = "e.school_id = $1 AND e.is_active = true";
  if (academic_year_id) { params.push(academic_year_id); where += ` AND e.academic_year_id = $${params.length}`; }
  if (class_level_id) { params.push(class_level_id); where += ` AND e.class_level_id = $${params.length}`; }
  if (section_id) { params.push(section_id); where += ` AND e.section_id = $${params.length}`; }

  if (include_ledger !== "1") {
    const result = await pool.query(
      `SELECT e.id, e.admission_type, e.outcome, e.roll_no,
              s.admission_no, s.full_name, s.guardian_name, s.guardian_phone, s.address,
              cl.name AS class_name, sec.name AS section_name
       FROM enrollments e
       JOIN students s ON s.id = e.student_id
       JOIN class_levels cl ON cl.id = e.class_level_id
       JOIN sections sec ON sec.id = e.section_id
       WHERE ${where}
       ORDER BY cl.ladder_order, sec.name, s.full_name`,
      params,
    );
    return res.json(result.rows);
  }

  // Ledger totals computed here, per row, rather than one extra
  // request per enrollment from the caller — Fee Collection used to
  // fetch this school's roster and then issue one further GET per
  // student for their ledger; a school with 1,500+ enrolled students
  // turned that into 1,500+ sequential requests and the screen
  // genuinely failed to load. Same correlated-subquery totals
  // getEnrollmentLedger computes for one enrollment, just run once
  // per row here instead of once per round trip — and only viable now
  // that concessions.enrollment_id and allocations.charge_id/
  // payment_id are actually indexed (see the 1700000000016 migration
  // sitting right next to this change). Opt-in via include_ledger=1
  // rather than always-on: callers that only need the roster (the
  // admission-number preview, promotion's existing-students check)
  // shouldn't pay for aggregates they never read.
  const result = await pool.query(
    `SELECT e.id, e.admission_type, e.outcome, e.roll_no,
            s.admission_no, s.full_name, s.guardian_name, s.guardian_phone, s.address,
            cl.name AS class_name, sec.name AS section_name,
            COALESCE((SELECT SUM(c.amount) FROM charges c
                      WHERE c.enrollment_id = e.id AND c.reversed_by IS NULL), 0) AS charged,
            COALESCE((SELECT SUM(co.amount) FROM concessions co
                      WHERE co.enrollment_id = e.id AND co.reversed_by IS NULL), 0) AS conceded,
            COALESCE((SELECT SUM(a.amount) FROM allocations a
                      JOIN payments p ON p.id = a.payment_id
                      WHERE a.charge_id IN (SELECT id FROM charges WHERE enrollment_id = e.id)
                        AND p.clearing_status = 'cleared' AND p.reversed_by IS NULL), 0) AS paid,
            COALESCE((SELECT SUM(c.amount) FROM charges c
                      WHERE c.enrollment_id = e.id AND c.reversed_by IS NULL
                        AND c.is_arrear = true), 0) AS arrears_charged,
            COALESCE((SELECT SUM(c.amount) FROM charges c
                      WHERE c.enrollment_id = e.id AND c.reversed_by IS NULL
                        AND c.is_arrear = true), 0)
              - COALESCE((SELECT SUM(a.amount) FROM allocations a
                          JOIN payments p ON p.id = a.payment_id
                          JOIN charges c ON c.id = a.charge_id
                          WHERE c.enrollment_id = e.id AND c.reversed_by IS NULL AND c.is_arrear = true
                            AND p.clearing_status = 'cleared' AND p.reversed_by IS NULL), 0) AS arrears_balance
     FROM enrollments e
     JOIN students s ON s.id = e.student_id
     JOIN class_levels cl ON cl.id = e.class_level_id
     JOIN sections sec ON sec.id = e.section_id
     WHERE ${where}
     ORDER BY cl.ladder_order, sec.name, s.full_name`,
    params,
  );
  res.json(result.rows.map((r) => ({
    ...r,
    ledger: {
      charged: Number(r.charged), conceded: Number(r.conceded), paid: Number(r.paid),
      balance: Number(r.charged) - Number(r.conceded) - Number(r.paid),
      arrearsCharged: Number(r.arrears_charged), arrearsBalance: Number(r.arrears_balance),
    },
  })));
});
