import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/index.js";
import { requireCapability } from "../middleware/permissions.js";
import { ImportServiceError, commitImport, stageImport, templateCsv } from "../services/importer.js";

export const importRouter = Router();
importRouter.use(requireCapability("manage_admissions"));

const stageSchema = z.object({
  academic_year_id: z.string().uuid(),
  filename: z.string().min(1).max(255),
  content: z.string().min(1),
  column_map: z.record(z.string(), z.number().int().nonnegative()).optional(),
});

importRouter.post("/stage", async (req, res) => {
  const parsed = stageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ detail: parsed.error.issues[0]?.message });
  const d = parsed.data;

  try {
    const batch = await stageImport({
      schoolId: req.school!.id, academicYearId: d.academic_year_id,
      filename: d.filename, content: d.content, columnMap: d.column_map,
      createdBy: req.user!.id,
    });
    res.status(201).json(batch);
  } catch (err) {
    if (err instanceof ImportServiceError) return res.status(400).json({ detail: err.message });
    throw err;
  }
});

importRouter.get("/batches/:id/rows", async (req, res) => {
  const batch = await pool.query(
    `SELECT * FROM import_batches WHERE id = $1 AND school_id = $2`,
    [String(req.params.id), req.school!.id],
  );
  if (!batch.rows[0]) return res.status(404).end();

  const onlyErrors = req.query.errors_only === "1";
  const rows = await pool.query(
    `SELECT * FROM import_rows WHERE batch_id = $1
       ${onlyErrors ? "AND jsonb_array_length(errors) > 0" : ""}
     ORDER BY line_no`,
    [String(req.params.id)],
  );
  res.json({ batch: batch.rows[0], rows: rows.rows });
});

const commitSchema = z.object({
  skip_invalid: z.boolean().optional().default(true),
});

importRouter.post("/batches/:id/commit", async (req, res) => {
  const parsed = commitSchema.safeParse(req.body ?? {});
  const skipInvalid = parsed.success ? parsed.data.skip_invalid : true;

  try {
    const result = await commitImport(String(req.params.id), {
      skipInvalid, committedBy: req.user!.id,
    });
    res.json(result);
  } catch (err) {
    if (err instanceof ImportServiceError) return res.status(400).json({ detail: err.message });
    throw err;
  }
});

importRouter.get("/template", (_req, res) => {
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=student-import-template.csv");
  res.send(templateCsv());
});
