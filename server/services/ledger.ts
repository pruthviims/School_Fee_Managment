/**
 * balance = charged - conceded - cleared payments, always computed fresh
 * from the ledger tables, never cached in a mutable column — the same
 * invariant Enrollment.ledger()/.balance enforced in the Django version.
 * Storing a running balance is exactly how a fee register ends up
 * disagreeing with itself after a reversal or a late-clearing cheque.
 */

import type { PoolClient } from "pg";
import { pool } from "../db/index.js";

export interface EnrollmentLedger {
  charged: number;
  conceded: number;
  grossPaid: number;
  refunded: number;
  paid: number;
  balance: number;
  arrearsCharged: number;
  arrearsBalance: number;
}

export async function getEnrollmentLedger(
  enrollmentId: string, client: PoolClient | typeof pool = pool,
): Promise<EnrollmentLedger> {
  // Sequential, not Promise.all: when called with a transactional client
  // (a single checked-out connection, as carryForwardArrears does), that
  // one connection can't run overlapping queries — only the pool itself
  // can fan out concurrent queries across separate connections.
  const chargedResult = await client.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM charges
     WHERE enrollment_id = $1 AND reversed_by IS NULL`,
    [enrollmentId],
  );
  const concededResult = await client.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM concessions
     WHERE enrollment_id = $1 AND reversed_by IS NULL`,
    [enrollmentId],
  );
  const paidResult = await client.query(
    `SELECT COALESCE(SUM(a.amount), 0) AS total
     FROM allocations a
     JOIN payments p ON p.id = a.payment_id
     WHERE a.charge_id IN (SELECT id FROM charges WHERE enrollment_id = $1)
       AND p.clearing_status = 'cleared' AND p.reversed_by IS NULL`,
    [enrollmentId],
  );
  // Money actually paid back to the family — a refund never touches
  // payments/allocations/charges (the original receipt stays exactly
  // as it was, per its own history), so it has to be pulled in here
  // explicitly as its own, separate deduction. Every refund on this
  // enrollment counts: there's no "reversed" or "voided" concept on
  // refunds themselves to filter by.
  const refundedResult = await client.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM refunds WHERE enrollment_id = $1`,
    [enrollmentId],
  );

  // Same shape as the totals above, restricted to is_arrear charges —
  // lets the UI show "of this balance, ₹X is carried forward from last
  // year" instead of one undifferentiated number, since staff (and
  // parents) reading the screen have no other way to tell a fresh
  // charge from an old one still owed.
  const arrearsChargedResult = await client.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM charges
     WHERE enrollment_id = $1 AND reversed_by IS NULL AND is_arrear = true`,
    [enrollmentId],
  );
  const arrearsPaidResult = await client.query(
    `SELECT COALESCE(SUM(a.amount), 0) AS total
     FROM allocations a
     JOIN payments p ON p.id = a.payment_id
     JOIN charges c ON c.id = a.charge_id
     WHERE c.enrollment_id = $1 AND c.reversed_by IS NULL AND c.is_arrear = true
       AND p.clearing_status = 'cleared' AND p.reversed_by IS NULL`,
    [enrollmentId],
  );

  const charged = chargedResult.rows[0].total;
  const conceded = concededResult.rows[0].total;
  const grossPaid = paidResult.rows[0].total;
  const refunded = refundedResult.rows[0].total;
  const paid = grossPaid - refunded;
  const arrearsCharged = arrearsChargedResult.rows[0].total;
  const arrearsPaid = arrearsPaidResult.rows[0].total;

  return {
    charged, conceded, grossPaid, refunded, paid, balance: charged - conceded - paid,
    arrearsCharged, arrearsBalance: arrearsCharged - arrearsPaid,
  };
}

/**
 * The same totals as getEnrollmentLedger, for many enrollments in one
 * query instead of one call per enrollment — extracted here as the
 * shared implementation after the exact same correlated-subquery SQL
 * had already been hand-duplicated once (Fee Collection's
 * include_ledger=1). A caller that needs N enrollments' balances
 * should call this once, not getEnrollmentLedger N times: that
 * per-enrollment pattern is exactly what made Fee Collection
 * unusable at 1,500+ students, and Class Promotion's preview (which
 * computes a balance for every enrolled student, not just the ones
 * moving) has the identical shape.
 *
 * Only viable now that concessions.enrollment_id and
 * allocations.charge_id/payment_id are actually indexed (see the
 * 1700000000016 migration) — the same dependency
 * getEnrollmentLedger's own correlated subqueries have always had.
 */
export async function getBulkEnrollmentLedgers(
  enrollmentIds: string[], client: PoolClient | typeof pool = pool,
): Promise<Map<string, EnrollmentLedger>> {
  if (enrollmentIds.length === 0) return new Map();

  const result = await client.query(
    `SELECT e.id,
            COALESCE((SELECT SUM(c.amount) FROM charges c
                      WHERE c.enrollment_id = e.id AND c.reversed_by IS NULL), 0) AS charged,
            COALESCE((SELECT SUM(co.amount) FROM concessions co
                      WHERE co.enrollment_id = e.id AND co.reversed_by IS NULL), 0) AS conceded,
            COALESCE((SELECT SUM(a.amount) FROM allocations a
                      JOIN payments p ON p.id = a.payment_id
                      WHERE a.charge_id IN (SELECT id FROM charges WHERE enrollment_id = e.id)
                        AND p.clearing_status = 'cleared' AND p.reversed_by IS NULL), 0) AS gross_paid,
            COALESCE((SELECT SUM(r.amount) FROM refunds r WHERE r.enrollment_id = e.id), 0) AS refunded,
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
     WHERE e.id = ANY($1::uuid[])`,
    [enrollmentIds],
  );

  const map = new Map<string, EnrollmentLedger>();
  for (const r of result.rows) {
    const charged = Number(r.charged), conceded = Number(r.conceded);
    const grossPaid = Number(r.gross_paid), refunded = Number(r.refunded);
    const paid = grossPaid - refunded;
    const arrearsCharged = Number(r.arrears_charged), arrearsBalance = Number(r.arrears_balance);
    map.set(r.id, {
      charged, conceded, grossPaid, refunded, paid, balance: charged - conceded - paid,
      arrearsCharged, arrearsBalance,
    });
  }
  return map;
}
