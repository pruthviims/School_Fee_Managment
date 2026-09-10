/**
 * Receiving money and allocating it against charges.
 *
 * Two things here are easy to get wrong and expensive to fix:
 *
 *   1. Allocation. Partial payment is normal, so a payment cannot simply
 *      point at an invoice. It splits across specific charges, oldest
 *      due first, arrears ahead of current-year dues.
 *
 *   2. Clearing status. A cheque or an unconfirmed gateway payment is NOT
 *      money until it clears. Only CLEARED payments count toward the
 *      balance, and a bounce reverses the allocations rather than
 *      deleting the payment — the receipt number was already issued and
 *      must stay in the sequence.
 */

import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../db/index.js";
import { fiscalYearFor, issueDocumentNumber } from "./documentCounter.js";

export class CollectionError extends Error {}

const INSTANT_MODES = new Set(["cash", "upi", "card", "netbanking", "neft"]);

interface ChargeAmount {
  chargeId: string;
  amount: number;
}

async function nextReceiptNo(client: PoolClient, schoolId: string, receivedOn: string) {
  return issueDocumentNumber(client, {
    schoolId, docType: "receipt", fiscalYear: fiscalYearFor(new Date(receivedOn)), prefix: "RCP/",
  });
}

/**
 * Spread a payment across charges. Default policy is oldest-due-first
 * with arrears ahead of current dues — what a school office does by
 * hand. An explicit list overrides it for a parent who insists on
 * paying a specific head.
 */
async function allocate(
  client: PoolClient, payment: { id: string; school_id: string; enrollment_id: string; amount: number },
  chargeAmounts?: ChargeAmount[],
) {
  let pairs: ChargeAmount[];

  if (chargeAmounts && chargeAmounts.length > 0) {
    pairs = chargeAmounts;
  } else {
    const chargesResult = await client.query(
      `SELECT c.id,
              c.amount - COALESCE((
                SELECT SUM(a.amount) FROM allocations a
                JOIN payments p ON p.id = a.payment_id
                WHERE a.charge_id = c.id AND p.clearing_status = 'cleared'
                  AND p.reversed_by IS NULL
              ), 0) AS outstanding
       FROM charges c
       WHERE c.enrollment_id = $1 AND c.reversed_by IS NULL
       ORDER BY c.is_arrear DESC, c.due_on ASC, c.id ASC
       FOR UPDATE`,
      [payment.enrollment_id],
    );

    let remaining = payment.amount;
    pairs = [];
    for (const charge of chargesResult.rows) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, charge.outstanding);
      if (take > 0) {
        pairs.push({ chargeId: charge.id, amount: take });
        remaining -= take;
      }
    }
    // Any remainder is an advance payment — recorded but unallocated, and
    // settles against the next term's charges once they're posted.
  }

  for (const { chargeId, amount } of pairs) {
    await client.query(
      `INSERT INTO allocations (school_id, payment_id, charge_id, amount)
       VALUES ($1, $2, $3, $4)`,
      [payment.school_id, payment.id, chargeId, amount],
    );
  }
  return pairs;
}

export interface RecordPaymentInput {
  enrollmentId: string;
  amount: number;
  mode: "cash" | "upi" | "card" | "netbanking" | "neft" | "cheque" | "dd";
  receivedOn?: Date;
  instrumentRef?: string;
  collectedBy?: string | null;
  chargeAmounts?: ChargeAmount[];
  gateway?: string;
  gatewayOrderId?: string;
  gatewayPaymentId?: string;
  convenienceFee?: number;
}

/** Cash, UPI, card and net banking clear immediately. Cheques and DDs sit PENDING until confirmed. */
export async function recordPayment(input: RecordPaymentInput): Promise<unknown> {
  if (input.amount <= 0) throw new CollectionError("Payment amount must be positive.");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const enrollmentResult = await client.query(
      `SELECT e.id, e.school_id, ay.status AS academic_year_status
       FROM enrollments e JOIN academic_years ay ON ay.id = e.academic_year_id
       WHERE e.id = $1`,
      [input.enrollmentId],
    );
    const enrollment = enrollmentResult.rows[0];
    if (!enrollment) throw new CollectionError("Enrollment not found.");
    if (enrollment.academic_year_status === "closed") {
      throw new CollectionError("Cannot post payments to a closed academic year.");
    }

    const receivedOn = (input.receivedOn ?? new Date()).toISOString().slice(0, 10);
    const instant = INSTANT_MODES.has(input.mode);
    const receiptNo = await nextReceiptNo(client, enrollment.school_id, receivedOn);

    const paymentResult = await client.query(
      `INSERT INTO payments
         (school_id, receipt_no, enrollment_id, amount, mode, clearing_status,
          received_on, cleared_on, instrument_ref, collected_by, created_by,
          gateway, gateway_order_id, gateway_payment_id, convenience_fee)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11, $12, $13, $14)
       RETURNING *`,
      [enrollment.school_id, receiptNo, input.enrollmentId, input.amount, input.mode,
       instant ? "cleared" : "pending", receivedOn, instant ? receivedOn : null,
       input.instrumentRef ?? "", input.collectedBy ?? null,
       input.gateway ?? "", input.gatewayOrderId ?? "", input.gatewayPaymentId ?? "",
       input.convenienceFee ?? 0],
    );
    const payment = paymentResult.rows[0];

    await allocate(client, payment, input.chargeAmounts);

    await client.query("COMMIT");
    return payment;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The exact scenario reported: office typed 15,660 instead of 15,560,
 * already generated a receipt, needs it fixed. Never edits the
 * original payment in place — that would mean two different receipts
 * could exist for the same payment_id at different points in time,
 * which is exactly the kind of thing an auditor (or a parent disputing
 * a figure) needs never to be possible. Instead: the original's own
 * allocations are removed (its charges become outstanding again,
 * exactly as if it had never been paid), a genuinely new payment is
 * recorded with the corrected figures and its own real receipt number,
 * and the original's reversed_by is pointed at that new payment —
 * mirroring the payments schema's own design (reversed_by references
 * payments, not a zero-amount marker row, since amount must stay
 * positive here unlike charges/concessions).
 */
export async function voidAndCorrectPayment(
  paymentId: string,
  correction: { amount: number; mode: string; instrumentRef?: string; receivedOn?: Date },
  correctedBy: string,
  reason: string,
): Promise<{ voided: unknown; corrected: unknown }> {
  if (correction.amount <= 0) throw new CollectionError("Corrected amount must be positive.");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const oldResult = await client.query(`SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [paymentId]);
    const old = oldResult.rows[0];
    if (!old) throw new CollectionError("Payment not found.");
    if (old.reversed_by) throw new CollectionError("This payment has already been corrected.");

    await client.query(`DELETE FROM allocations WHERE payment_id = $1`, [old.id]);

    const receivedOn = (correction.receivedOn ?? new Date()).toISOString().slice(0, 10);
    const instant = INSTANT_MODES.has(correction.mode);
    const receiptNo = await nextReceiptNo(client, old.school_id, receivedOn);

    const newResult = await client.query(
      `INSERT INTO payments
         (school_id, receipt_no, enrollment_id, amount, mode, clearing_status,
          received_on, cleared_on, instrument_ref, collected_by, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
       RETURNING *`,
      [old.school_id, receiptNo, old.enrollment_id, correction.amount, correction.mode,
       instant ? "cleared" : "pending", receivedOn, instant ? receivedOn : null,
       correction.instrumentRef ?? "", correctedBy],
    );
    const corrected = newResult.rows[0];

    await allocate(client, corrected);

    const reversedResult = await client.query(
      `UPDATE payments SET reversed_by = $1, reversal_reason = $2 WHERE id = $3 RETURNING *`,
      [corrected.id, reason, old.id],
    );

    await client.query("COMMIT");
    return { voided: reversedResult.rows[0], corrected };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function markCleared(paymentId: string, clearedOn?: Date): Promise<unknown> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(`SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [paymentId]);
    const payment = existing.rows[0];
    if (!payment) throw new CollectionError("Payment not found.");
    if (payment.clearing_status === "cleared") {
      await client.query("COMMIT");
      return payment;
    }

    const on = (clearedOn ?? new Date()).toISOString().slice(0, 10);
    const updated = await client.query(
      `UPDATE payments SET clearing_status = 'cleared', cleared_on = $2
       WHERE id = $1 RETURNING *`,
      [paymentId, on],
    );
    await client.query("COMMIT");
    return updated.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * A bounced cheque doesn't delete the payment — the receipt was issued
 * and the number must stay in the sequence. Flip the status and drop the
 * allocations so the balance reopens.
 */
export async function markBounced(paymentId: string, reason = "Instrument bounced"): Promise<unknown> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE payments
       SET clearing_status = 'bounced', reversal_reason = $2, cleared_on = NULL
       WHERE id = $1`,
      [paymentId, reason],
    );
    await client.query(`DELETE FROM allocations WHERE payment_id = $1`, [paymentId]);
    const result = await client.query(`SELECT * FROM payments WHERE id = $1`, [paymentId]);
    await client.query("COMMIT");
    return result.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------
// Online payments
// ---------------------------------------------------------------------

/**
 * Razorpay-style HMAC-SHA256 over the raw request body. Uses the RAW
 * bytes, not parsed-and-re-serialised JSON — key ordering would differ
 * and every signature would fail.
 */
export function verifyWebhookSignature(rawBody: Buffer, signature: string, secret: string): boolean {
  if (!secret || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const UNIQUE_VIOLATION = "23505";

/**
 * Idempotent webhook handler. Returns [payment, created]. Gateways retry,
 * duplicate, and reorder deliveries — the unique index on
 * (gateway, gateway_payment_id) is the real defence. This catches the
 * constraint violation rather than checking-then-inserting, because
 * check-then-insert is exactly the race concurrent retries would hit.
 */
export async function handleGatewayWebhook(input: {
  enrollmentId: string; gateway: string; gatewayOrderId: string;
  gatewayPaymentId: string; amount: number; convenienceFee?: number;
}): Promise<[unknown, boolean]> {
  const existing = await pool.query(
    `SELECT * FROM payments WHERE gateway = $1 AND gateway_payment_id = $2`,
    [input.gateway, input.gatewayPaymentId],
  );
  if (existing.rows[0]) return [existing.rows[0], false];

  try {
    const payment = await recordPayment({
      enrollmentId: input.enrollmentId,
      amount: input.amount,
      mode: "upi",
      gateway: input.gateway,
      gatewayOrderId: input.gatewayOrderId,
      gatewayPaymentId: input.gatewayPaymentId,
      convenienceFee: input.convenienceFee ?? 0,
      instrumentRef: input.gatewayPaymentId,
    });
    return [payment, true];
  } catch (err) {
    if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
      // Concurrent retry won the race; its row is authoritative.
      const result = await pool.query(
        `SELECT * FROM payments WHERE gateway = $1 AND gateway_payment_id = $2`,
        [input.gateway, input.gatewayPaymentId],
      );
      return [result.rows[0], false];
    }
    throw err;
  }
}

/** Day book — the number the office reconciles against the cash drawer. */
export async function dailyCollection(schoolId: string, on: string) {
  const result = await pool.query(
    `SELECT mode, amount FROM payments
     WHERE school_id = $1 AND received_on = $2
       AND clearing_status = 'cleared' AND reversed_by IS NULL`,
    [schoolId, on],
  );

  const byMode: Record<string, number> = {};
  let total = 0;
  for (const row of result.rows) {
    byMode[row.mode] = (byMode[row.mode] ?? 0) + row.amount;
    total += row.amount;
  }
  return { date: on, total, byMode, count: result.rows.length };
}
