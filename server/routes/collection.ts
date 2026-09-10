/**
 * Payment collection over HTTP. The gateway webhook handler is exported
 * separately (not mounted on collectionRouter) because it needs the RAW
 * request body for HMAC verification — see server/app.ts, where it's
 * wired in with express.raw() ahead of the general express.json()
 * middleware. Verifying a signature against re-serialised JSON instead
 * of the original bytes is a real, easy-to-make mistake: key ordering
 * differs and every signature fails.
 */

import type { Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/index.js";
import { requireCapability, requireMember } from "../middleware/permissions.js";
import {
  CollectionError, dailyCollection, handleGatewayWebhook, markBounced, markCleared,
  recordPayment, verifyWebhookSignature, voidAndCorrectPayment,
} from "../services/collection.js";
import { logActivity } from "../services/auditLog.js";
import { ReceiptError, getReceiptData } from "../services/receipts.js";

export const collectionRouter = Router();
collectionRouter.use(requireMember);

const recordPaymentSchema = z.object({
  enrollment_id: z.string().uuid(),
  amount: z.number().int().positive(), // paise
  mode: z.enum(["cash", "upi", "card", "netbanking", "neft", "cheque", "dd"]),
  instrument_ref: z.string().optional().default(""),
  charge_amounts: z.array(z.object({
    charge_id: z.string().uuid(), amount: z.number().int().positive(),
  })).optional(),
});

collectionRouter.post("/payments", requireCapability("collect_payments"), async (req, res) => {
  const parsed = recordPaymentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ detail: parsed.error.issues[0]?.message });
  const d = parsed.data;

  try {
    const payment = await recordPayment({
      enrollmentId: d.enrollment_id, amount: d.amount, mode: d.mode,
      instrumentRef: d.instrument_ref, collectedBy: req.user!.id,
      chargeAmounts: d.charge_amounts?.map((c) => ({ chargeId: c.charge_id, amount: c.amount })),
    });
    res.status(201).json(payment);
  } catch (err) {
    if (err instanceof CollectionError) return res.status(400).json({ detail: err.message });
    throw err;
  }
});

collectionRouter.post(
  "/payments/:id/clear", requireCapability("collect_payments"),
  async (req, res) => {
    try {
      const payment = await markCleared(String(req.params.id));
      res.json(payment);
    } catch (err) {
      if (err instanceof CollectionError) return res.status(400).json({ detail: err.message });
      throw err;
    }
  },
);

const bounceSchema = z.object({ reason: z.string().optional() });

collectionRouter.post(
  "/payments/:id/bounce", requireCapability("collect_payments"),
  async (req, res) => {
    const parsed = bounceSchema.safeParse(req.body ?? {});
    const payment = await markBounced(String(req.params.id), parsed.success ? parsed.data.reason : undefined);
    res.json(payment);
  },
);

const voidSchema = z.object({
  amount: z.number().int().positive(),
  mode: z.enum(["cash", "upi", "card", "netbanking", "neft", "cheque", "dd"]),
  instrument_ref: z.string().max(100).optional().default(""),
  reason: z.string().max(500).optional().default(""),
});

// Accountant/Owner only — confirmed as the same sensitivity level as
// the refund action, not something Front Desk can do unilaterally on
// their own collected payments.
collectionRouter.post(
  "/payments/:id/void", requireCapability("void_payments"),
  async (req, res) => {
    const parsed = voidSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ detail: parsed.error.issues[0]?.message });
    const d = parsed.data;

    try {
      const { voided, corrected } = await voidAndCorrectPayment(
        String(req.params.id),
        { amount: d.amount, mode: d.mode, instrumentRef: d.instrument_ref },
        req.user!.id,
        d.reason,
      ) as { voided: { enrollment_id: string; amount: number }; corrected: { id: string; amount: number } };

      const student = await pool.query(
        `SELECT s.full_name FROM enrollments e JOIN students s ON s.id = e.student_id WHERE e.id = $1`,
        [voided.enrollment_id],
      );
      await logActivity(pool, req, {
        action: "payment.void",
        entityType: "payment",
        entityId: String(req.params.id),
        description: `Corrected a payment for ${student.rows[0]?.full_name || "a student"} — ` +
          `₹${(voided.amount / 100).toFixed(2)} → ₹${(corrected.amount / 100).toFixed(2)}`,
        metadata: { old_amount: voided.amount, new_amount: corrected.amount, new_payment_id: corrected.id },
      });

      res.json({ voided, corrected });
    } catch (err) {
      if (err instanceof CollectionError) return res.status(400).json({ detail: err.message });
      throw err;
    }
  },
);

collectionRouter.get(
  "/day-book", requireCapability("view_reports"),
  async (req, res) => {
    const on = typeof req.query.date === "string" ? req.query.date : new Date().toISOString().slice(0, 10);
    const report = await dailyCollection(req.school!.id, on);
    res.json(report);
  },
);

// Any active member — this is what PaymentModal's history list reads
// from before a new payment is even recorded.
collectionRouter.get("/enrollments/:id/payments", async (req, res) => {
  const result = await pool.query(
    `SELECT id, receipt_no, amount, mode, clearing_status, received_on, instrument_ref
     FROM payments
     WHERE enrollment_id = $1 AND school_id = $2 AND reversed_by IS NULL
     ORDER BY created_at DESC`,
    [String(req.params.id), req.school!.id],
  );
  res.json(result.rows);
});

// Any active member can look up and reprint a receipt (a parent who lost
// theirs is a routine front-desk request), matching how the fees app's
// original receipt_pdf view was gated under IsMember rather than
// collect_payments specifically.
collectionRouter.get("/payments/:id/receipt-data", async (req, res) => {
  try {
    const data = await getReceiptData(String(req.params.id));
    res.json(data);
  } catch (err) {
    if (err instanceof ReceiptError) return res.status(404).json({ detail: err.message });
    throw err;
  }
});

// ---------------------------------------------------------------------
// Gateway webhook — registered directly in app.ts with express.raw(),
// not part of collectionRouter's normal express.json() pipeline.
// ---------------------------------------------------------------------

const webhookSchema = z.object({
  enrollment_id: z.string().uuid(),
  order_id: z.string(),
  payment_id: z.string(),
  amount: z.number().int().positive(),
  convenience_fee: z.number().int().nonnegative().optional().default(0),
});

export async function webhookHandler(req: Request, res: Response) {
  const gateway = String(req.params.gateway);
  const secret = process.env[`${gateway.toUpperCase()}_WEBHOOK_SECRET`];
  const signature = req.header("x-webhook-signature") ?? "";
  const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}));

  if (!secret || !verifyWebhookSignature(rawBody, signature, secret)) {
    return res.status(401).json({ detail: "Invalid webhook signature." });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({ detail: "Malformed payload." });
  }

  const parsed = webhookSchema.safeParse(payload);
  if (!parsed.success) return res.status(400).json({ detail: parsed.error.issues[0]?.message });
  const d = parsed.data;

  const [payment, created] = await handleGatewayWebhook({
    enrollmentId: d.enrollment_id, gateway, gatewayOrderId: d.order_id,
    gatewayPaymentId: d.payment_id, amount: d.amount, convenienceFee: d.convenience_fee,
  });
  res.status(created ? 201 : 200).json(payment);
}
