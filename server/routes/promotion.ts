/**
 * The three-phase promotion workflow over HTTP. A ProposedMove genuinely
 * crosses the wire here — preview() runs server-side, the office reviews
 * and adjusts it in the browser, then assignSections()/commit() take the
 * (possibly-edited) moves back. commit() never trusts anything about
 * "is this actionable" from the client; it's recomputed server-side from
 * the move's own fields every time — see isActionable() in
 * server/services/promotion.ts.
 */

import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/index.js";
import { requireCapability } from "../middleware/permissions.js";
import { logActivity } from "../services/auditLog.js";
import {
  PromotionError, type ProposedMove, assignSections, commit, preview, previewSummary, reverseBatch,
} from "../services/promotion.js";

export const promotionRouter = Router();
promotionRouter.use(requireCapability("manage_admissions"));

const proposedMoveSchema = z.object({
  kind: z.enum(["promote", "graduate", "blocked"]),
  enrollmentId: z.string().uuid(),
  studentId: z.string().uuid(),
  admissionNo: z.string(),
  studentName: z.string(),
  fromClassName: z.string(),
  fromSectionName: z.string(),
  toClassId: z.string().uuid().nullable(),
  toClassName: z.string().nullable(),
  toSectionId: z.string().uuid().nullable(),
  streamId: z.string().uuid().nullable(),
  balance: z.number(),
  needsStream: z.boolean(),
  needsOptin: z.boolean(),
  blockedReason: z.string(),
}) satisfies z.ZodType<ProposedMove>;

const previewSchema = z.object({
  from_year_id: z.string().uuid(),
  to_year_id: z.string().uuid(),
  block_on_dues: z.boolean().optional().default(false),
  exclude_enrollment_ids: z.array(z.string().uuid()).optional().default([]),
});

promotionRouter.post("/preview", async (req, res) => {
  const parsed = previewSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ detail: parsed.error.issues[0]?.message });
  const d = parsed.data;

  try {
    const result = await preview({
      fromYearId: d.from_year_id, toYearId: d.to_year_id,
      blockOnDues: d.block_on_dues, excludeEnrollmentIds: d.exclude_enrollment_ids,
    });
    res.json({ ...result, summary: previewSummary(result) });
  } catch (err) {
    if (err instanceof PromotionError) return res.status(400).json({ detail: err.message });
    throw err;
  }
});

const assignSectionsSchema = z.object({
  to_year_id: z.string().uuid(),
  strategy: z.enum(["keep", "balance"]).optional().default("keep"),
  moves: z.array(proposedMoveSchema),
});

promotionRouter.post("/assign-sections", async (req, res) => {
  const parsed = assignSectionsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ detail: parsed.error.issues[0]?.message });
  const d = parsed.data;

  try {
    const moves = await assignSections(d.moves, { toYearId: d.to_year_id, strategy: d.strategy });
    res.json({ moves });
  } catch (err) {
    if (err instanceof PromotionError) return res.status(400).json({ detail: err.message });
    throw err;
  }
});

const commitSchema = z.object({
  from_year_id: z.string().uuid(),
  to_year_id: z.string().uuid(),
  moves: z.array(proposedMoveSchema),
  carry_arrears: z.boolean().optional().default(true),
  generate_new_charges: z.boolean().optional().default(true),
});

promotionRouter.post("/commit", async (req, res) => {
  const parsed = commitSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ detail: parsed.error.issues[0]?.message });
  const d = parsed.data;

  try {
    const batch = await commit({
      fromYearId: d.from_year_id, toYearId: d.to_year_id, moves: d.moves,
      carryArrears: d.carry_arrears, generateNewCharges: d.generate_new_charges,
      committedBy: req.user!.id,
    }) as { id: string };
    await logActivity(pool, req, {
      action: "promotion.commit",
      entityType: "promotion_batch",
      entityId: batch.id,
      description: `Committed a promotion batch — ${d.moves.length} student${d.moves.length === 1 ? "" : "s"} moved`,
      metadata: { from_year_id: d.from_year_id, to_year_id: d.to_year_id, move_count: d.moves.length },
    });
    res.status(201).json(batch);
  } catch (err) {
    if (err instanceof PromotionError) return res.status(400).json({ detail: err.message });
    throw err;
  }
});

promotionRouter.post("/batches/:id/reverse", async (req, res) => {
  try {
    const batch = await reverseBatch(String(req.params.id));
    res.json(batch);
  } catch (err) {
    if (err instanceof PromotionError) return res.status(400).json({ detail: err.message });
    throw err;
  }
});
