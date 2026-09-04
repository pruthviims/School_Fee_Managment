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
import { requireCapability, requireMember } from "../middleware/permissions.js";
import {
  CollectionError, dailyCollection, handleGatewayWebhook, markBounced, markCleared,
  recordPayment, verifyWebhookSignature,
} from "../services/collection.js";

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

collectionRouter.get(
  "/day-book", requireCapability("view_reports"),
  async (req, res) => {
    const on = typeof req.query.date === "string" ? req.query.date : new Date().toISOString().slice(0, 10);
    const report = await dailyCollection(req.school!.id, on);
    res.json(report);
  },
);

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
