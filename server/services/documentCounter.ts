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

export type DocType = "receipt" | "invoice" | "tc";

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

  return formatDocNumber(counter.prefix, fiscalYear, value);
}

function formatDocNumber(prefix: string, fiscalYear: string, value: number): string {
  return `${prefix}${fiscalYear}/${String(value).padStart(5, "0")}`;
}

/**
 * The bulk sibling of issueDocumentNumber, for a caller that needs many
 * sequential numbers in one operation rather than one at a time — built
 * for import, which used to call issueDocumentNumber (3 queries: an
 * upsert, a row-locked SELECT, an UPDATE) once per row with an opening
 * balance. For a real roster where every row carries one, that's the
 * same one-at-a-time cost the rest of import's bulk rewrite already
 * eliminated for students, enrollments, and charges — recreated here
 * for receipt numbers specifically, in one atomic reservation instead.
 *
 * Same sequential-and-gapless guarantee issueDocumentNumber has: the
 * whole block is reserved by incrementing next_value by `count` in a
 * single UPDATE, under the same FOR UPDATE row lock, inside the
 * caller's transaction — nothing else can issue a number from this
 * counter until this transaction commits or rolls back, exactly as
 * issueDocumentNumber already relies on.
 */
export async function reserveDocumentNumberBlock(
  client: PoolClient,
  { schoolId, docType, fiscalYear, prefix = "" }:
    { schoolId: string; docType: DocType; fiscalYear: string; prefix?: string },
  count: number,
): Promise<string[]> {
  if (count === 0) return [];

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
  const start: number = counter.next_value;

  await client.query(
    `UPDATE document_counters SET next_value = next_value + $4
     WHERE school_id = $1 AND doc_type = $2 AND fiscal_year = $3`,
    [schoolId, docType, fiscalYear, count],
  );

  const numbers: string[] = [];
  for (let i = 0; i < count; i++) {
    numbers.push(formatDocNumber(counter.prefix, fiscalYear, start + i));
  }
  return numbers;
}

/** Indian financial year: 1 April to 31 March. */
export function fiscalYearFor(d: Date): string {
  const start = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; // getMonth() is 0-indexed; April = 3
  return `${start}-${String(start + 1).slice(-2)}`;
}
