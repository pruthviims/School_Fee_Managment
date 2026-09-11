/**
 * The configuration surface everything else in this domain depends on —
 * a school has to exist as academic years, class levels, sections, and a
 * fee structure before an admission or a charge means anything. Reads
 * are open to any member; writes need manage_fee_structure (an
 * accountant or owner), matching the same capability the frontend's
 * "Fees Setup" screen would gate on.
 */

import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/index.js";
import { requireCapability, requireMember } from "../middleware/permissions.js";
import { logActivity } from "../services/auditLog.js";
import { generateChargesBulk } from "../services/billing.js";
import { recordPayment } from "../services/collection.js";

export const setupRouter = Router();
setupRouter.use(requireMember);

const writeGuard = requireCapability("manage_fee_structure");

// The canonical 15-class Indian school ladder + a handful of common fee
// heads, created in one transaction rather than the frontend making 20
// sequential round trips (one per row) to seed a brand-new school — each
// of those round trips is a full serverless-function invocation with its
// own database connection, and 20 of them back to back was slow enough
// on a cold deployment to look like the app had hung. Idempotent: safe
// to call again, existing rows are left alone.
// Requested grouping: Pre-LKG/LKG/UKG = Pre Primary, I through VII =
// Primary (7 classes), VIII through X = Higher Primary (3 classes),
// 1st/2nd PU = College. Reuses the existing stage enum values rather
// than adding a new one — "middle" now covers VIII-X and is labelled
// "Higher Primary" wherever it's shown (see STAGE_LABELS), and
// "secondary" is simply unused rather than requiring a schema change.
const DEFAULT_CLASS_LEVELS = [
  { name: "Pre-LKG", ladder_order: 1, stage: "pre_primary" },
  { name: "LKG", ladder_order: 2, stage: "pre_primary" },
  { name: "UKG", ladder_order: 3, stage: "pre_primary" },
  { name: "I", ladder_order: 4, stage: "primary" },
  { name: "II", ladder_order: 5, stage: "primary" },
  { name: "III", ladder_order: 6, stage: "primary" },
  { name: "IV", ladder_order: 7, stage: "primary" },
  { name: "V", ladder_order: 8, stage: "primary" },
  { name: "VI", ladder_order: 9, stage: "primary" },
  { name: "VII", ladder_order: 10, stage: "primary" },
  { name: "VIII", ladder_order: 11, stage: "middle" },
  { name: "IX", ladder_order: 12, stage: "middle" },
  { name: "X", ladder_order: 13, stage: "middle" },
  { name: "1st PU", ladder_order: 14, stage: "puc", requires_stream: true, requires_explicit_optin: true },
  { name: "2nd PU", ladder_order: 15, stage: "puc", requires_stream: true, is_terminal: true },
];
const DEFAULT_FEE_HEADS = [
  { name: "Tuition fee", display_order: 1 },
  { name: "Admission fee", is_one_time: true, display_order: 2 },
  { name: "Development fee", display_order: 3 },
  { name: "Library fee", display_order: 4 },
  { name: "Exam fee", display_order: 5 },
];

setupRouter.post("/seed-defaults", writeGuard, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const c of DEFAULT_CLASS_LEVELS) {
      await client.query(
        `INSERT INTO class_levels
           (school_id, name, ladder_order, stage, requires_stream, requires_explicit_optin, is_terminal)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT DO NOTHING`,
        [req.school!.id, c.name, c.ladder_order, c.stage,
         c.requires_stream ?? false, c.requires_explicit_optin ?? false, c.is_terminal ?? false],
      );
    }
    for (const h of DEFAULT_FEE_HEADS) {
      await client.query(
        `INSERT INTO fee_heads (school_id, name, is_one_time, display_order)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [req.school!.id, h.name, h.is_one_time ?? false, h.display_order],
      );
    }

    await client.query("COMMIT");

    const [levels, heads] = await Promise.all([
      pool.query(`SELECT * FROM class_levels WHERE school_id = $1 ORDER BY ladder_order`, [req.school!.id]),
      pool.query(`SELECT * FROM fee_heads WHERE school_id = $1 ORDER BY display_order`, [req.school!.id]),
    ]);
    res.json({ classLevels: levels.rows, feeHeads: heads.rows });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------
// Academic years
// ---------------------------------------------------------------------

const yearSchema = z.object({
  name: z.string().min(1).max(20),
  starts_on: z.string(),
  ends_on: z.string(),
  status: z.enum(["planning", "active", "closed"]).optional().default("planning"),
});

setupRouter.get("/academic-years", async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM academic_years WHERE school_id = $1 ORDER BY starts_on DESC`,
    [req.school!.id],
  );
  res.json(result.rows);
});

setupRouter.post("/academic-years", writeGuard, async (req, res) => {
  const parsed = yearSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ detail: parsed.error.issues[0]?.message });
  if (parsed.data.ends_on <= parsed.data.starts_on) {
    return res.status(400).json({ detail: "End date must be after the start date." });
  }
  try {
    const result = await pool.query(
      `INSERT INTO academic_years (school_id, name, starts_on, ends_on, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.school!.id, parsed.data.name, parsed.data.starts_on, parsed.data.ends_on,
       parsed.data.status, req.user!.id],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return res.status(409).json({ detail: "That academic year already exists." });
    }
    throw err;
  }
});

setupRouter.patch("/academic-years/:id", writeGuard, async (req, res) => {
  const parsed = yearSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ detail: parsed.error.issues[0]?.message });
  const fields = Object.keys(parsed.data);
  if (fields.length === 0) return res.status(400).json({ detail: "Nothing to update." });

  const setClause = fields.map((f, i) => `${f} = $${i + 3}`).join(", ");
  const result = await pool.query(
    `UPDATE academic_years SET ${setClause} WHERE id = $1 AND school_id = $2 RETURNING *`,
    [req.params.id, req.school!.id, ...fields.map((f) => (parsed.data as any)[f])],
  );
  if (!result.rows[0]) return res.status(404).end();
  res.json(result.rows[0]);
});

// ---------------------------------------------------------------------
// Class levels
// ---------------------------------------------------------------------

const classLevelSchema = z.object({
  name: z.string().min(1).max(30),
  ladder_order: z.number().int().positive(),
  stage: z.enum(["pre_primary", "primary", "middle", "secondary", "puc"]),
  requires_explicit_optin: z.boolean().optional().default(false),
  requires_stream: z.boolean().optional().default(false),
  is_terminal: z.boolean().optional().default(false),
});

setupRouter.get("/class-levels", async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM class_levels WHERE school_id = $1 ORDER BY ladder_order`,
    [req.school!.id],
  );
  res.json(result.rows);
});

setupRouter.post("/class-levels", writeGuard, async (req, res) => {
  const parsed = classLevelSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ detail: parsed.error.issues[0]?.message });
  try {
    const d = parsed.data;
    const result = await pool.query(
      `INSERT INTO class_levels
         (school_id, name, ladder_order, stage, requires_explicit_optin, requires_stream, is_terminal)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.school!.id, d.name, d.ladder_order, d.stage, d.requires_explicit_optin,
       d.requires_stream, d.is_terminal],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return res.status(409).json({ detail: "That class name or ladder position is already used." });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------

const sectionSchema = z.object({
  academic_year_id: z.string().uuid(),
  class_level_id: z.string().uuid(),
  name: z.string().min(1).max(10),
  capacity: z.number().int().positive().optional().default(40),
});

setupRouter.get("/sections", async (req, res) => {
  const { academic_year_id, class_level_id } = req.query;
  const params: unknown[] = [req.school!.id];
  let where = "s.school_id = $1";
  if (academic_year_id) {
    params.push(academic_year_id);
    where += ` AND s.academic_year_id = $${params.length}`;
  }
  if (class_level_id) {
    params.push(class_level_id);
    where += ` AND s.class_level_id = $${params.length}`;
  }
  const result = await pool.query(
    `SELECT s.*, cl.name AS class_name, cl.ladder_order FROM sections s
     JOIN class_levels cl ON cl.id = s.class_level_id
     WHERE ${where} ORDER BY cl.ladder_order, s.name`,
    params,
  );
  res.json(result.rows);
});

setupRouter.post("/sections", writeGuard, async (req, res) => {
  const parsed = sectionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ detail: parsed.error.issues[0]?.message });
  try {
    const d = parsed.data;
    const result = await pool.query(
      `INSERT INTO sections (school_id, academic_year_id, class_level_id, name, capacity)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.school!.id, d.academic_year_id, d.class_level_id, d.name, d.capacity],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return res.status(409).json({ detail: "That section already exists for this class and year." });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------
// Fee heads and fee structure
// ---------------------------------------------------------------------

const feeHeadSchema = z.object({
  name: z.string().min(1).max(80),
  basis: z.enum(["per_class", "per_slab", "flat"]).optional().default("per_class"),
  is_one_time: z.boolean().optional().default(false),
  is_optional: z.boolean().optional().default(false),
  is_refundable: z.boolean().optional().default(false),
  display_order: z.number().int().optional().default(0),
});

setupRouter.get("/fee-heads", async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM fee_heads WHERE school_id = $1 ORDER BY display_order, name`,
    [req.school!.id],
  );
  res.json(result.rows);
});

setupRouter.post("/fee-heads", writeGuard, async (req, res) => {
  const parsed = feeHeadSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ detail: parsed.error.issues[0]?.message });
  try {
    const d = parsed.data;
    const result = await pool.query(
      `INSERT INTO fee_heads (school_id, name, basis, is_one_time, is_optional, is_refundable, display_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.school!.id, d.name, d.basis, d.is_one_time, d.is_optional, d.is_refundable, d.display_order],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return res.status(409).json({ detail: "A fee head with that name already exists." });
    }
    throw err;
  }
});

const feeHeadUpdateSchema = feeHeadSchema.partial()
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update." });

setupRouter.patch("/fee-heads/:id", writeGuard, async (req, res) => {
  // A fee head (e.g. "Admission fee") is shared across every class that
  // charges it, so editing it here — including the one-time/recurring
  // flag — is a school-wide decision, not a per-class one. That's a
  // deliberate difference from how this screen used to let each class
  // keep its own independent copy of a component with the same name.
  const parsed = feeHeadUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ detail: parsed.error.issues[0]?.message });

  const fields = Object.keys(parsed.data);
  const setClause = fields.map((f, i) => `${f} = $${i + 3}`).join(", ");
  const result = await pool.query(
    `UPDATE fee_heads SET ${setClause} WHERE id = $1 AND school_id = $2 RETURNING *`,
    [String(req.params.id), req.school!.id, ...fields.map((f) => (parsed.data as any)[f])],
  );
  if (!result.rows[0]) return res.status(404).end();
  res.json(result.rows[0]);
});

setupRouter.delete("/fee-heads/:id", writeGuard, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM fee_heads WHERE id = $1 AND school_id = $2 RETURNING id`,
      [String(req.params.id), req.school!.id],
    );
    if (!result.rows[0]) return res.status(404).end();
    res.status(204).end();
  } catch (err) {
    // Every foreign key pointing at fee_heads (fee_structures, charges,
    // concessions) is ON DELETE RESTRICT — Postgres itself refuses this
    // once the head has ever actually been priced or charged, which is
    // exactly the protection wanted here: a head that's only ever
    // existed as an empty, unpriced row (added by mistake, never given
    // an amount for any class) can go; one that's already real school
    // history can't, silently or otherwise.
    if ((err as { code?: string }).code === "23503") {
      return res.status(409).json({
        detail: "This fee is already priced or has been charged to a student, so it can't be deleted. " +
          "Remove its prices from every class instead if it's no longer needed.",
      });
    }
    throw err;
  }
});

const feeStructureSchema = z.object({
  academic_year_id: z.string().uuid(),
  class_level_id: z.string().uuid(),
  fee_head_id: z.string().uuid(),
  stream_id: z.string().uuid().nullable().optional().default(null),
  amount: z.number().int().nonnegative(), // paise
  term_no: z.number().int().positive().optional().default(1),
  due_on: z.string(),
});

setupRouter.get("/fee-structure", async (req, res) => {
  const { academic_year_id, class_level_id } = req.query;
  const params: unknown[] = [req.school!.id];
  let where = "fs.school_id = $1";
  if (academic_year_id) {
    params.push(academic_year_id);
    where += ` AND fs.academic_year_id = $${params.length}`;
  }
  if (class_level_id) {
    params.push(class_level_id);
    where += ` AND fs.class_level_id = $${params.length}`;
  }
  const result = await pool.query(
    `SELECT fs.*, fh.name AS fee_head_name, fh.is_optional, fh.is_one_time
     FROM fee_structures fs JOIN fee_heads fh ON fh.id = fs.fee_head_id
     WHERE ${where} ORDER BY fh.display_order, fs.term_no`,
    params,
  );
  res.json(result.rows);
});

setupRouter.post("/fee-structure", writeGuard, async (req, res) => {
  const parsed = feeStructureSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ detail: parsed.error.issues[0]?.message });
  try {
    const d = parsed.data;
    const result = await pool.query(
      `INSERT INTO fee_structures
         (school_id, academic_year_id, class_level_id, fee_head_id, stream_id, amount, term_no, due_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [req.school!.id, d.academic_year_id, d.class_level_id, d.fee_head_id, d.stream_id,
       d.amount, d.term_no, d.due_on],
    );

    const names = await pool.query(
      `SELECT cl.name AS class_name, fh.name AS head_name
       FROM class_levels cl, fee_heads fh WHERE cl.id = $1 AND fh.id = $2`,
      [d.class_level_id, d.fee_head_id],
    );
    await logActivity(pool, req, {
      action: "fee_structure.create",
      entityType: "fee_structure",
      entityId: result.rows[0].id,
      description: `Set ${names.rows[0]?.head_name || "a fee"} for ${names.rows[0]?.class_name || "a class"} ` +
        `to ₹${(d.amount / 100).toFixed(2)} (term ${d.term_no})`,
      metadata: { amount: d.amount, class_level_id: d.class_level_id, fee_head_id: d.fee_head_id },
    });

    res.status(201).json(result.rows[0]);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return res.status(409).json({ detail: "That fee line already exists for this class, head, and term." });
    }
    throw err;
  }
});

const copyFeeStructureSchema = z.object({
  academic_year_id: z.string().uuid(),
  source_class_id: z.string().uuid(),
  target_class_ids: z.array(z.string().uuid()).min(1),
});

// One server-side query for every target class at once, replacing what
// the frontend previously did as one sequential browser request per
// (target class × fee head × term) — for even a modest fee structure
// copied across the rest of a 15-class ladder, that was dozens of
// individual round trips, slow enough to genuinely time out, and
// structured to silently swallow any failure per line (not just an
// "already exists" conflict), which is exactly how a school could end
// up with a partial copy and no real indication of what actually
// happened. ON CONFLICT DO NOTHING here relies on
// uniq_fee_structure_line correctly catching a duplicate even when
// stream_id is NULL (see the NULLS NOT DISTINCT migration sitting
// right next to this route) — without that fix, the exact same
// "silently didn't skip a real duplicate" gap would just move here.
setupRouter.post("/fee-structure/copy", writeGuard, async (req, res) => {
  const parsed = copyFeeStructureSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ detail: parsed.error.issues[0]?.message });
  const d = parsed.data;

  const result = await pool.query(
    `INSERT INTO fee_structures
       (school_id, academic_year_id, class_level_id, fee_head_id, stream_id, amount, term_no, due_on)
     SELECT fs.school_id, fs.academic_year_id, t.target_id, fs.fee_head_id, fs.stream_id,
            fs.amount, fs.term_no, fs.due_on
     FROM fee_structures fs
     CROSS JOIN unnest($1::uuid[]) AS t(target_id)
     WHERE fs.school_id = $2 AND fs.academic_year_id = $3 AND fs.class_level_id = $4 AND fs.amount > 0
     ON CONFLICT ON CONSTRAINT uniq_fee_structure_line DO NOTHING
     RETURNING id`,
    [d.target_class_ids, req.school!.id, d.academic_year_id, d.source_class_id],
  );

  const names = await pool.query(
    `SELECT name FROM class_levels WHERE id = $1`, [d.source_class_id],
  );
  await logActivity(pool, req, {
    action: "fee_structure.copy",
    entityType: "fee_structure",
    entityId: null,
    description: `Copied ${names.rows[0]?.name || "a class"}'s fee structure to ` +
      `${d.target_class_ids.length} other class${d.target_class_ids.length === 1 ? "" : "es"} ` +
      `(${result.rows.length} new line${result.rows.length === 1 ? "" : "s"} — existing ones left alone)`,
    metadata: { source_class_id: d.source_class_id, target_class_ids: d.target_class_ids,
      created: result.rows.length },
  });

  res.json({ created: result.rows.length });
});

// A student enrolled into a class before it had any pricing — most
// commonly via import, where a school's real roster often gets
// brought in before every class is fully priced — never gets charges
// generated for it, since nothing retroactively does that once
// pricing catches up. This surfaces how many such students exist for
// a given class/year, so Fee Structure can prompt to fix it right
// after pricing is entered, rather than leaving it to be discovered
// later as a student mysteriously owing nothing.
setupRouter.get("/fee-structure/uncharged-count", async (req, res) => {
  const { academic_year_id, class_level_id } = req.query;
  if (!academic_year_id || !class_level_id) {
    return res.status(400).json({ detail: "academic_year_id and class_level_id are required." });
  }
  const result = await pool.query(
    `SELECT count(*) FROM enrollments e
     WHERE e.school_id = $1 AND e.academic_year_id = $2 AND e.class_level_id = $3 AND e.is_active = true
       AND NOT EXISTS (SELECT 1 FROM charges c WHERE c.enrollment_id = e.id AND c.source = 'structure')`,
    [req.school!.id, academic_year_id, class_level_id],
  );
  res.json({ uncharged: Number(result.rows[0].count) });
});

const generateMissingChargesSchema = z.object({
  academic_year_id: z.string().uuid(),
  class_level_id: z.string().uuid(),
});

// generateCharges() is documented as idempotent per (enrollment,
// fee_head, term) specifically so it can be safely re-run — this
// leans on exactly that guarantee to "catch up" every enrollment in a
// class at once, rather than requiring a per-student action. Also
// recovers any "amount paid so far" that import captured but couldn't
// apply at the time, because there was nothing to allocate it against
// yet — that value never disappeared, it's still sitting in
// import_rows.raw, unused until now.
setupRouter.post("/fee-structure/generate-missing-charges", writeGuard, async (req, res) => {
  const parsed = generateMissingChargesSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ detail: parsed.error.issues[0]?.message });
  const d = parsed.data;

  const priced = await pool.query(
    `SELECT 1 FROM fee_structures
     WHERE school_id = $1 AND academic_year_id = $2 AND class_level_id = $3 AND amount > 0
     LIMIT 1`,
    [req.school!.id, d.academic_year_id, d.class_level_id],
  );
  if (!priced.rows[0]) {
    return res.status(400).json({ detail: "This class has no fees set up yet." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const enrollmentsResult = await client.query(
      `SELECT id, student_id, stream_id, admission_type FROM enrollments
       WHERE school_id = $1 AND academic_year_id = $2 AND class_level_id = $3 AND is_active = true`,
      [req.school!.id, d.academic_year_id, d.class_level_id],
    );

    // checkExisting: true — unlike import and promotion, these
    // enrollments already existed before this action ran and may
    // already be partially billed, so the "already charged"
    // de-duplication can't be safely skipped the way it correctly is
    // for a batch of brand-new enrollments.
    const createdByEnrollment = await generateChargesBulk(
      enrollmentsResult.rows.map((e) => ({
        enrollmentId: e.id, schoolId: req.school!.id, academicYearId: d.academic_year_id,
        classLevelId: d.class_level_id, streamId: e.stream_id, admissionType: e.admission_type,
      })),
      { createdBy: req.user!.id, client, checkExisting: true },
    );

    let studentsBilled = 0, chargesCreated = 0, paymentsRecorded = 0;

    for (const enrollment of enrollmentsResult.rows) {
      const created = createdByEnrollment.get(enrollment.id) ?? 0;
      if (created === 0) continue;
      studentsBilled++;
      chargesCreated += created;

      // Only ever applies once per enrollment — recorded payments are
      // checked for the same marker import itself uses, so re-running
      // this action (safe and expected, matching generateChargesBulk's
      // own idempotency here) never records the opening balance twice.
      const alreadyPaid = await client.query(
        `SELECT 1 FROM payments
         WHERE enrollment_id = $1 AND instrument_ref = 'Opening balance from import' LIMIT 1`,
        [enrollment.id],
      );
      if (alreadyPaid.rows[0]) continue;

      const importRow = await client.query(
        `SELECT raw FROM import_rows WHERE student_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [enrollment.student_id],
      );
      const amountPaidPaise = Number(importRow.rows[0]?.raw?._amount_paid_paise ?? "0");
      if (amountPaidPaise > 0) {
        await recordPayment({
          enrollmentId: enrollment.id, amount: amountPaidPaise, mode: "cash",
          instrumentRef: "Opening balance from import", collectedBy: req.user!.id, client,
        });
        paymentsRecorded++;
      }
    }

    const className = await client.query(`SELECT name FROM class_levels WHERE id = $1`,
      [d.class_level_id]);
    await logActivity(client, req, {
      action: "fee_structure.generate_missing_charges",
      entityType: "fee_structure",
      entityId: null,
      description: `Generated charges for ${studentsBilled} student${studentsBilled === 1 ? "" : "s"} ` +
        `in ${className.rows[0]?.name || "a class"} who had none yet` +
        (paymentsRecorded > 0 ? ` (${paymentsRecorded} opening-balance payment` +
          `${paymentsRecorded === 1 ? "" : "s"} from import also applied)` : ""),
      metadata: { class_level_id: d.class_level_id, studentsBilled, chargesCreated, paymentsRecorded },
    });

    await client.query("COMMIT");
    res.json({ studentsBilled, chargesCreated, paymentsRecorded });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

const feeStructureUpdateSchema = z.object({
  amount: z.number().int().nonnegative().optional(),
  due_on: z.string().optional(),
}).refine((v) => v.amount !== undefined || v.due_on !== undefined, { message: "Nothing to update." });

setupRouter.patch("/fee-structure/:id", writeGuard, async (req, res) => {
  const parsed = feeStructureUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ detail: parsed.error.issues[0]?.message });

  const fields = Object.keys(parsed.data);
  const setClause = fields.map((f, i) => `${f} = $${i + 3}`).join(", ");
  const result = await pool.query(
    `UPDATE fee_structures SET ${setClause} WHERE id = $1 AND school_id = $2 RETURNING *`,
    [String(req.params.id), req.school!.id, ...fields.map((f) => (parsed.data as any)[f])],
  );
  if (!result.rows[0]) return res.status(404).end();

  const names = await pool.query(
    `SELECT cl.name AS class_name, fh.name AS head_name
     FROM fee_structures fs
     JOIN class_levels cl ON cl.id = fs.class_level_id
     JOIN fee_heads fh ON fh.id = fs.fee_head_id
     WHERE fs.id = $1`,
    [result.rows[0].id],
  );
  await logActivity(pool, req, {
    action: "fee_structure.update",
    entityType: "fee_structure",
    entityId: String(req.params.id),
    description: `Updated ${names.rows[0]?.head_name || "a fee"} for ${names.rows[0]?.class_name || "a class"} ` +
      `(${fields.join(", ")})`,
    metadata: parsed.data,
  });

  res.json(result.rows[0]);
});

setupRouter.delete("/fee-structure/:id", writeGuard, async (req, res) => {
  // Amounts already charged to a student are frozen onto their own Charge
  // row when the admission happened (see billing.generateCharges) — this
  // only removes the price-list entry going forward, never touches a
  // charge that already exists.
  const before = await pool.query(
    `SELECT cl.name AS class_name, fh.name AS head_name, fs.amount
     FROM fee_structures fs
     JOIN class_levels cl ON cl.id = fs.class_level_id
     JOIN fee_heads fh ON fh.id = fs.fee_head_id
     WHERE fs.id = $1 AND fs.school_id = $2`,
    [String(req.params.id), req.school!.id],
  );
  const result = await pool.query(
    `DELETE FROM fee_structures WHERE id = $1 AND school_id = $2 RETURNING id`,
    [String(req.params.id), req.school!.id],
  );
  if (!result.rows[0]) return res.status(404).end();

  await logActivity(pool, req, {
    action: "fee_structure.delete",
    entityType: "fee_structure",
    entityId: String(req.params.id),
    description: `Removed ${before.rows[0]?.head_name || "a fee"} from ${before.rows[0]?.class_name || "a class"}`,
  });

  res.status(204).end();
});
