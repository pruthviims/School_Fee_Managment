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

export const setupRouter = Router();
setupRouter.use(requireMember);

const writeGuard = requireCapability("manage_fee_structure");

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
  const { academic_year_id } = req.query;
  const params: unknown[] = [req.school!.id];
  let where = "school_id = $1";
  if (academic_year_id) {
    params.push(academic_year_id);
    where += ` AND academic_year_id = $${params.length}`;
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
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return res.status(409).json({ detail: "That fee line already exists for this class, head, and term." });
    }
    throw err;
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
  res.json(result.rows[0]);
});

setupRouter.delete("/fee-structure/:id", writeGuard, async (req, res) => {
  // Amounts already charged to a student are frozen onto their own Charge
  // row when the admission happened (see billing.generateCharges) — this
  // only removes the price-list entry going forward, never touches a
  // charge that already exists.
  const result = await pool.query(
    `DELETE FROM fee_structures WHERE id = $1 AND school_id = $2 RETURNING id`,
    [String(req.params.id), req.school!.id],
  );
  if (!result.rows[0]) return res.status(404).end();
  res.status(204).end();
});
