/**
 * Receipt and invoice numbers must be sequential AND gapless per school
 * per financial year for audit purposes. A serial/identity column leaves
 * gaps on a rolled-back transaction; a uuid has no order at all — neither
 * is acceptable for a financial document number.
 *
 * issueDocumentNumber MUST be called with a client that's inside an open
 * transaction that also writes the row this number belongs to (the
 * Payment or Invoice insert) — the row lock only protects against a
 * concurrent issuer if both hold it for the same transaction that
 * commits or rolls back together. Calling this outside a transaction, or
 * on a client whose transaction later rolls back after the caller reused
 * the number, would burn or double-issue a number.
 */

import type { PoolClient } from "pg";

export type DocType = "receipt" | "invoice";

export async function issueDocumentNumber(
  client: PoolClient,
  { schoolId, docType, fiscalYear, prefix = "" }:
    { schoolId: string; docType: DocType; fiscalYear: string; prefix?: string },
): Promise<string> {
  await client.query(
    `INSERT INTO document_counters (school_id, doc_type, fiscal_year, prefix)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (school_id, doc_type, fiscal_year) DO NOTHING`,
    [schoolId, docType, fiscalYear, prefix],
  );

  const result = await client.query(
    `SELECT next_value, prefix FROM document_counters
     WHERE school_id = $1 AND doc_type = $2 AND fiscal_year = $3
     FOR UPDATE`,
    [schoolId, docType, fiscalYear],
  );
  const counter = result.rows[0];
  const value: number = counter.next_value;

  await client.query(
    `UPDATE document_counters SET next_value = next_value + 1
     WHERE school_id = $1 AND doc_type = $2 AND fiscal_year = $3`,
    [schoolId, docType, fiscalYear],
  );

  return `${counter.prefix}${fiscalYear}/${String(value).padStart(5, "0")}`;
}

/** Indian financial year: 1 April to 31 March. */
export function fiscalYearFor(d: Date): string {
  const start = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; // getMonth() is 0-indexed; April = 3
  return `${start}-${String(start + 1).slice(-2)}`;
}
