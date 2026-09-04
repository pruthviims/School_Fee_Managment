/**
 * Turning the published fee structure into charges a student owes, and
 * turning charges into an invoice document.
 *
 * The critical rule enforced here: charges are a SNAPSHOT. Once written,
 * a later edit to fee_structures must not change what an existing
 * student owes — see head_name/amount being copied onto the charge row
 * rather than the charge referencing fee_structures live.
 */

import type { PoolClient } from "pg";
import { pool } from "../db/index.js";
import { fiscalYearFor, issueDocumentNumber } from "./documentCounter.js";
import { getEnrollmentLedger } from "./ledger.js";

export class BillingError extends Error {}

interface EnrollmentRow {
  id: string;
  school_id: string;
  academic_year_id: string;
  class_level_id: string;
  section_id: string;
  stream_id: string | null;
  admission_type: string;
  academic_year_status: string;
  academic_year_name: string;
  academic_year_starts_on: string;
  student_full_name: string;
  section_label: string;
}

async function loadEnrollment(client: PoolClient, enrollmentId: string): Promise<EnrollmentRow> {
  const result = await client.query(
    `SELECT e.id, e.school_id, e.academic_year_id, e.class_level_id, e.section_id,
            e.stream_id, e.admission_type,
            ay.status AS academic_year_status, ay.name AS academic_year_name,
            ay.starts_on AS academic_year_starts_on,
            s.full_name AS student_full_name,
            (cl.name || '-' || sec.name) AS section_label
     FROM enrollments e
     JOIN academic_years ay ON ay.id = e.academic_year_id
     JOIN students s ON s.id = e.student_id
     JOIN sections sec ON sec.id = e.section_id
     JOIN class_levels cl ON cl.id = sec.class_level_id
     WHERE e.id = $1`,
    [enrollmentId],
  );
  const row = result.rows[0];
  if (!row) throw new BillingError("Enrollment not found.");
  return row;
}

/**
 * Snapshot the fee structure onto an enrollment. Idempotent per
 * (enrollment, fee_head, term_no) — re-running never duplicates charges,
 * so a half-failed admission can safely be retried.
 *
 * Accepts an optional `client` so this can participate in a caller's own
 * transaction (promotion's commit() does exactly this) instead of always
 * opening a fresh connection — a fresh connection can't see rows an
 * outer, still-open transaction has written but not yet committed.
 */
export async function generateCharges(
  enrollmentId: string,
  { optionalHeadIds = [], createdBy = null, client: providedClient }:
    { optionalHeadIds?: string[]; createdBy?: string | null; client?: PoolClient } = {},
): Promise<unknown[]> {
  const ownsConnection = !providedClient;
  const client = providedClient ?? await pool.connect();
  try {
    if (ownsConnection) await client.query("BEGIN");
    const enrollment = await loadEnrollment(client, enrollmentId);

    if (enrollment.academic_year_status === "closed") {
      throw new BillingError(
        `${enrollment.academic_year_name} is closed; no new charges may be posted.`,
      );
    }

    const optionalSet = new Set(optionalHeadIds);

    // A stream-specific price wins over the generic one; take both and
    // de-duplicate below so Science students get lab fees and Arts don't.
    const linesResult = await client.query(
      `SELECT fs.id, fs.fee_head_id, fs.stream_id, fs.amount, fs.term_no, fs.due_on,
              fh.name AS head_name, fh.is_optional, fh.is_one_time, fh.display_order
       FROM fee_structures fs
       JOIN fee_heads fh ON fh.id = fs.fee_head_id
       WHERE fs.school_id = $1 AND fs.academic_year_id = $2 AND fs.class_level_id = $3
         AND (fs.stream_id IS NULL OR fs.stream_id = $4)
       ORDER BY fh.display_order, fs.term_no, fs.stream_id NULLS LAST`,
      [enrollment.school_id, enrollment.academic_year_id, enrollment.class_level_id,
       enrollment.stream_id],
    );

    const alreadyResult = await client.query(
      `SELECT fee_head_id, term_no FROM charges
       WHERE enrollment_id = $1 AND source = 'structure'`,
      [enrollmentId],
    );
    const already = new Set(alreadyResult.rows.map((r) => `${r.fee_head_id}:${r.term_no}`));

    const seen = new Set<string>();
    const created: unknown[] = [];

    for (const line of linesResult.rows) {
      const key = `${line.fee_head_id}:${line.term_no}`;
      if (seen.has(key)) continue; // stream-specific row already handled this head+term

      if (line.is_optional && !optionalSet.has(line.fee_head_id)) continue;
      // One-time heads (admission fee) apply only to genuinely new students.
      if (line.is_one_time && enrollment.admission_type !== "new") continue;

      seen.add(key);
      if (already.has(key)) continue;

      const inserted = await client.query(
        `INSERT INTO charges
           (school_id, enrollment_id, fee_head_id, head_name, amount, term_no,
            due_on, source, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'structure', $8)
         RETURNING *`,
        [enrollment.school_id, enrollmentId, line.fee_head_id, line.head_name,
         line.amount, line.term_no, line.due_on, createdBy],
      );
      created.push(inserted.rows[0]);
    }

    if (ownsConnection) await client.query("COMMIT");
    return created;
  } catch (err) {
    if (ownsConnection) await client.query("ROLLBACK");
    throw err;
  } finally {
    if (ownsConnection) client.release();
  }
}

/**
 * Move an unpaid balance into the new academic year as a single opening
 * arrear charge, flagged so it reports separately from current-year
 * dues. Idempotent: re-running finds the existing arrear row and does
 * nothing. Accepts an optional `client` for the same reason
 * generateCharges does — see its docstring.
 */
export async function carryForwardArrears(
  { fromEnrollmentId, toEnrollmentId, createdBy = null, client: providedClient }:
    { fromEnrollmentId: string; toEnrollmentId: string; createdBy?: string | null; client?: PoolClient },
): Promise<unknown | null> {
  const ownsConnection = !providedClient;
  const client = providedClient ?? await pool.connect();
  try {
    if (ownsConnection) await client.query("BEGIN");
    const from = await loadEnrollment(client, fromEnrollmentId);
    const to = await loadEnrollment(client, toEnrollmentId);

    const ledger = await getEnrollmentLedger(fromEnrollmentId, client);
    if (ledger.balance <= 0) {
      if (ownsConnection) await client.query("COMMIT");
      return null;
    }

    const existing = await client.query(
      `SELECT * FROM charges
       WHERE enrollment_id = $1 AND is_arrear = true AND source_year_id = $2`,
      [toEnrollmentId, from.academic_year_id],
    );
    if (existing.rows[0]) {
      if (ownsConnection) await client.query("COMMIT");
      return existing.rows[0];
    }

    const inserted = await client.query(
      `INSERT INTO charges
         (school_id, enrollment_id, fee_head_id, head_name, amount, term_no,
          due_on, source, is_arrear, source_year_id, created_by)
       VALUES ($1, $2, NULL, $3, $4, 1, $5, 'arrear', true, $6, $7)
       RETURNING *`,
      [to.school_id, toEnrollmentId, `Arrears carried forward (${from.academic_year_name})`,
       ledger.balance, to.academic_year_starts_on, from.academic_year_id, createdBy],
    );
    if (ownsConnection) await client.query("COMMIT");
    return inserted.rows[0];
  } catch (err) {
    if (ownsConnection) await client.query("ROLLBACK");
    throw err;
  } finally {
    if (ownsConnection) client.release();
  }
}

/**
 * Bundle unbilled charges into a numbered demand note. A charge belongs
 * to at most one invoice, so re-issuing for the same term only picks up
 * what hasn't already been billed.
 */
export async function issueInvoice(
  enrollmentId: string,
  { termNo = null, includeArrears = true, issuedOn = new Date(), createdBy = null }:
    { termNo?: number | null; includeArrears?: boolean; issuedOn?: Date; createdBy?: string | null } = {},
): Promise<unknown> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const enrollment = await loadEnrollment(client, enrollmentId);

    let chargesQuery = `SELECT * FROM charges
      WHERE enrollment_id = $1 AND invoice_id IS NULL AND reversed_by IS NULL`;
    const params: unknown[] = [enrollmentId];

    if (termNo !== null) {
      params.push(termNo);
      chargesQuery += includeArrears
        ? ` AND (term_no = $2 OR is_arrear = true)`
        : ` AND term_no = $2`;
    } else if (!includeArrears) {
      chargesQuery += ` AND is_arrear = false`;
    }
    chargesQuery += " FOR UPDATE";

    const chargesResult = await client.query(chargesQuery, params);
    const charges = chargesResult.rows;
    if (charges.length === 0) {
      throw new BillingError("Nothing outstanding to invoice for this enrollment.");
    }

    const fiscalYear = fiscalYearFor(issuedOn);
    const invoiceNo = await issueDocumentNumber(client, {
      schoolId: enrollment.school_id, docType: "invoice", fiscalYear, prefix: "INV/",
    });

    const dueOn = charges
      .map((c) => c.due_on as string)
      .reduce((min, d) => (d < min ? d : min));

    const invoiceResult = await client.query(
      `INSERT INTO invoices
         (school_id, invoice_no, enrollment_id, issued_on, due_on,
          student_name_at_issue, class_at_issue, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [enrollment.school_id, invoiceNo, enrollmentId,
       issuedOn.toISOString().slice(0, 10), dueOn,
       enrollment.student_full_name, enrollment.section_label, createdBy],
    );
    const invoice = invoiceResult.rows[0];

    await client.query(
      `UPDATE charges SET invoice_id = $1 WHERE id = ANY($2::uuid[])`,
      [invoice.id, charges.map((c) => c.id)],
    );

    await client.query("COMMIT");
    return invoice;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Defaulter roll-up used by the dues report. */
export async function outstandingSummary(academicYearId: string) {
  const enrollmentsResult = await pool.query(
    `SELECT e.id, s.admission_no, s.full_name,
            (cl.name || '-' || sec.name) AS section_label
     FROM enrollments e
     JOIN students s ON s.id = e.student_id
     JOIN sections sec ON sec.id = e.section_id
     JOIN class_levels cl ON cl.id = sec.class_level_id
     WHERE e.academic_year_id = $1 AND e.is_active = true`,
    [academicYearId],
  );

  const rows: { enrollment: unknown; balance: number }[] = [];
  let total = 0;

  for (const enrollment of enrollmentsResult.rows) {
    const ledger = await getEnrollmentLedger(enrollment.id);
    if (ledger.balance > 0) {
      total += ledger.balance;
      rows.push({ enrollment, balance: ledger.balance });
    }
  }
  rows.sort((a, b) => b.balance - a.balance);

  return { rows, total, count: rows.length };
}
