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
  const paid = paidResult.rows[0].total;
  const arrearsCharged = arrearsChargedResult.rows[0].total;
  const arrearsPaid = arrearsPaidResult.rows[0].total;

  return {
    charged, conceded, paid, balance: charged - conceded - paid,
    arrearsCharged, arrearsBalance: arrearsCharged - arrearsPaid,
  };
}
