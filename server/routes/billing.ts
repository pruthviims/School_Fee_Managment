import { Router } from "express";
import { z } from "zod";
import { requireCapability } from "../middleware/permissions.js";
import { BillingError, issueInvoice, outstandingSummary } from "../services/billing.js";

export const billingRouter = Router();

const issueInvoiceSchema = z.object({
  term_no: z.number().int().positive().nullable().optional().default(null),
  include_arrears: z.boolean().optional().default(true),
});

billingRouter.post(
  "/enrollments/:id/invoice",
  requireCapability("collect_payments"),
  async (req, res) => {
    const parsed = issueInvoiceSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ detail: parsed.error.issues[0]?.message });

    try {
      const invoice = await issueInvoice(String(req.params.id), {
        termNo: parsed.data.term_no, includeArrears: parsed.data.include_arrears,
        createdBy: req.user!.id,
      });
      res.status(201).json(invoice);
    } catch (err) {
      if (err instanceof BillingError) return res.status(400).json({ detail: err.message });
      throw err;
    }
  },
);

billingRouter.get(
  "/academic-years/:id/defaulters",
  requireCapability("view_reports"),
  async (req, res) => {
    const summary = await outstandingSummary(String(req.params.id));
    res.json(summary);
  },
);
