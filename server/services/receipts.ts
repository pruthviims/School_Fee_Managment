/**
 * Receipt (and bill) DATA — not PDF rendering. The Django version used
 * WeasyPrint for that last step; this backend deliberately doesn't render
 * PDFs at all. The frontend already has its own jsPDF-based receipt
 * generator (matching the reference payslip app's pattern), so this
 * service's job stops at "assemble everything that generator needs" —
 * the same data Django's render_receipt_html() context dict held, before
 * html_to_pdf() ever touched it.
 *
 * Ledger note: line items here are every non-reversed CHARGE for the
 * enrollment — the full year's fee breakdown (Tuition per term,
 * Admission fee, Transport fee, whatever applies) — not just what this
 * specific payment happened to be allocated against. A receipt reads as
 * a full statement of the year's fees, with "Paid now" and "Net
 * payable" (computed separately, further down) making clear what this
 * particular payment covers. An advance/credit from overpaying today is
 * still called out as its own line, computed from this payment's own
 * allocations specifically.
 */

import { pool } from "../db/index.js";

export class ReceiptError extends Error {}

const ONES = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function underHundred(n: number): string {
  if (n < 20) return ONES[n];
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return TENS[tens] + (ones ? `-${ONES[ones]}` : "");
}

function underThousand(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (hundreds) parts.push(`${ONES[hundreds]} hundred`);
  if (rest) parts.push(underHundred(rest));
  return parts.join(" ");
}

/**
 * Indian numbering — lakh and crore, not million and billion. Every
 * off-the-shelf number-to-words library gives "one million two hundred
 * thousand" and a school accountant will send the receipt straight back.
 *
 *   1234567 paise-as-rupees -> "Twelve lakh thirty-four thousand five
 *                                hundred sixty-seven rupees only"
 */
export function amountInWords(paise: number): string {
  const rupees = Math.floor(Math.abs(paise) / 100);
  const paisePart = Math.round(Math.abs(paise) % 100);

  let words: string;
  if (rupees === 0) {
    words = "zero";
  } else {
    const crore = Math.floor(rupees / 10000000);
    let rest = rupees % 10000000;
    const lakh = Math.floor(rest / 100000);
    rest %= 100000;
    const thousand = Math.floor(rest / 1000);
    rest %= 1000;

    const chunks: string[] = [];
    if (crore) chunks.push(`${underThousand(crore)} crore`);
    if (lakh) chunks.push(`${underThousand(lakh)} lakh`);
    if (thousand) chunks.push(`${underThousand(thousand)} thousand`);
    if (rest) chunks.push(underThousand(rest));
    words = chunks.join(" ");
  }

  let out = `${words} rupees`;
  if (paisePart) out += ` and ${underHundred(paisePart)} paise`;
  out += " only";
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/** Indian digit grouping: 12,34,567.00 not 1,234,567.00. No currency symbol — see server/db bigint note for why paise stays a plain number. */
export function formatInr(paise: number): string {
  const negative = paise < 0;
  const abs = Math.abs(paise);
  const whole = Math.floor(abs / 100);
  const frac = Math.round(abs % 100);

  let s = String(whole);
  if (s.length > 3) {
    let head = s.slice(0, -3);
    const tail = s.slice(-3);
    const groups: string[] = [];
    while (head.length > 2) {
      groups.unshift(head.slice(-2));
      head = head.slice(0, -2);
    }
    if (head) groups.unshift(head);
    s = `${groups.join(",")},${tail}`;
  }
  const result = `${s}.${String(frac).padStart(2, "0")}`;
  return negative ? `-${result}` : result;
}

export interface ReceiptLine {
  name: string;
  term: number | null;
  amountPaise: number;
  amountDisplay: string;
}

export interface ReceiptData {
  school: { name: string; address: string; receiptFooter: string };
  headingText: string;
  docNo: string;
  docDate: string;
  student: { fullName: string; admissionNo: string };
  classLabel: string;
  academicYear: string;
  lines: ReceiptLine[];
  grossPaise: number;
  concessionPaise: number;
  netPaise: number;
  totalPaise: number;
  totalDisplay: string;
  totalWords: string;
  mode: string;
  instrumentRef: string;
  collectedBy: string;
  priorPayments: { receiptNo: string; receivedOn: string; amountPaise: number }[];
  balanceAfterPaise: number;
}

export async function getReceiptData(paymentId: string): Promise<ReceiptData> {
  const paymentResult = await pool.query(
    `SELECT p.*, u.full_name AS collected_by_name, u.email AS collected_by_email
     FROM payments p LEFT JOIN users u ON u.id = p.collected_by
     WHERE p.id = $1`,
    [paymentId],
  );
  const payment = paymentResult.rows[0];
  if (!payment) throw new ReceiptError("Payment not found.");

  const enrollmentResult = await pool.query(
    `SELECT e.id, e.academic_year_id, s.full_name AS student_name, s.admission_no,
            sch.name AS school_name, sch.address AS school_address,
            sch.receipt_footer, ay.name AS year_name,
            (cl.name || '-' || sec.name) AS class_label
     FROM enrollments e
     JOIN students s ON s.id = e.student_id
     JOIN schools sch ON sch.id = e.school_id
     JOIN academic_years ay ON ay.id = e.academic_year_id
     JOIN sections sec ON sec.id = e.section_id
     JOIN class_levels cl ON cl.id = sec.class_level_id
     WHERE e.id = $1`,
    [payment.enrollment_id],
  );
  const enrollment = enrollmentResult.rows[0];
  if (!enrollment) throw new ReceiptError("Enrollment not found for this payment.");

  // Every non-reversed charge for the enrollment — the full year's
  // itemized fee breakdown (Tuition per term, Admission fee, Transport
  // fee, whatever applies), not just what this specific payment happened
  // to be allocated against. A parent reading a receipt wants to see the
  // whole picture — what's owed in total, broken down by particular —
  // with "Paid now" and "Total fees"/"Net payable" below (computed
  // separately, further down) making clear what this specific payment
  // covers versus the year as a whole. Matches getInvoiceData's own
  // charges query below, for the same reason.
  const chargesResult = await pool.query(
    `SELECT head_name, term_no, amount FROM charges
     WHERE enrollment_id = $1 AND reversed_by IS NULL
     ORDER BY due_on, id`,
    [payment.enrollment_id],
  );
  const lines: ReceiptLine[] = chargesResult.rows.map((r) => ({
    name: r.head_name, term: r.term_no, amountPaise: r.amount, amountDisplay: formatInr(r.amount),
  }));

  // Whether this specific payment covered more than what was actually
  // owed at the time (an advance/credit) is still worth surfacing
  // separately — computed from this payment's own allocations, not the
  // full-breakdown lines above.
  const allocationsResult = await pool.query(
    `SELECT COALESCE(SUM(a.amount), 0) AS allocated FROM allocations a WHERE a.payment_id = $1`,
    [paymentId],
  );
  const allocatedTotal = Number(allocationsResult.rows[0].allocated);
  const unallocated = payment.amount - allocatedTotal;
  if (unallocated > 0) {
    lines.push({
      name: "Advance (unallocated)", term: null,
      amountPaise: unallocated, amountDisplay: formatInr(unallocated),
    });
  }

  // Every earlier cleared payment for this enrollment, oldest first — the
  // "for record purposes" instalment history — plus the balance
  // immediately after THIS payment specifically, computed from cleared
  // allocations up to and including it rather than "current" state, so
  // reprinting an older receipt among several later ones still shows what
  // was true at that point in time, not today's balance.
  const priorResult = await pool.query(
    // Excludes this payment by id, not by timestamp comparison — Postgres
    // timestamptz has microsecond precision but JS Date only has
    // millisecond precision, so comparing a round-tripped JS Date against
    // its own source row with <= can spuriously come out false. See the
    // ledger query below, which hit exactly this.
    `SELECT receipt_no, received_on, amount FROM payments
     WHERE enrollment_id = $1 AND id != $2 AND clearing_status = 'cleared'
       AND reversed_by IS NULL AND created_at < $3
     ORDER BY created_at ASC`,
    [payment.enrollment_id, paymentId, payment.created_at],
  );
  const priorPayments = priorResult.rows.map((r) => ({
    receiptNo: r.receipt_no, receivedOn: r.received_on, amountPaise: r.amount,
  }));

  const ledgerAsOfResult = await pool.query(
    `SELECT
       (SELECT COALESCE(SUM(amount), 0) FROM charges
        WHERE enrollment_id = $1 AND reversed_by IS NULL) AS charged,
       (SELECT COALESCE(SUM(amount), 0) FROM concessions
        WHERE enrollment_id = $1 AND reversed_by IS NULL) AS conceded,
       (SELECT COALESCE(SUM(a.amount), 0) FROM allocations a
        JOIN payments p ON p.id = a.payment_id
        WHERE a.charge_id IN (SELECT id FROM charges WHERE enrollment_id = $1)
          AND p.clearing_status = 'cleared' AND p.reversed_by IS NULL
          AND (p.id = $2 OR p.created_at < $3)) AS paid_through_this_payment`,
    [payment.enrollment_id, paymentId, payment.created_at],
  );
  const { charged, conceded, paid_through_this_payment: paidThrough } = ledgerAsOfResult.rows[0];
  const balanceAfterPaise = charged - conceded - paidThrough;

  return {
    school: {
      name: enrollment.school_name, address: enrollment.school_address,
      receiptFooter: enrollment.receipt_footer,
    },
    headingText: "Fee receipt",
    docNo: payment.receipt_no,
    docDate: payment.received_on,
    student: { fullName: enrollment.student_name, admissionNo: enrollment.admission_no },
    classLabel: enrollment.class_label,
    academicYear: enrollment.year_name,
    lines,
    // The year's total price and total waiver, not "as of this payment" —
    // unlike balanceAfterPaise, these don't meaningfully drift over time
    // once charges are generated and concessions granted, so today's
    // ledger totals are what a reprint should show regardless of when
    // the payment happened.
    grossPaise: charged,
    concessionPaise: conceded,
    netPaise: charged - conceded,
    totalPaise: payment.amount,
    totalDisplay: formatInr(payment.amount),
    totalWords: amountInWords(payment.amount),
    mode: payment.mode,
    instrumentRef: payment.instrument_ref,
    collectedBy: payment.collected_by_name || payment.collected_by_email || "",
    priorPayments,
    balanceAfterPaise,
  };
}

export interface InvoiceData {
  school: { name: string; address: string; receiptFooter: string };
  headingText: string;
  docNo: string;
  docDate: string;
  dueDate: string;
  student: { fullName: string; admissionNo: string };
  classLabel: string;
  lines: ReceiptLine[];
  totalPaise: number;
  totalDisplay: string;
  totalWords: string;
}

export async function getInvoiceData(invoiceId: string): Promise<InvoiceData> {
  const invoiceResult = await pool.query(
    `SELECT i.*, sch.name AS school_name, sch.address AS school_address, sch.receipt_footer
     FROM invoices i JOIN schools sch ON sch.id = i.school_id
     WHERE i.id = $1`,
    [invoiceId],
  );
  const invoice = invoiceResult.rows[0];
  if (!invoice) throw new ReceiptError("Invoice not found.");

  const linesResult = await pool.query(
    `SELECT head_name, term_no, amount FROM charges
     WHERE invoice_id = $1 AND reversed_by IS NULL
     ORDER BY due_on, id`,
    [invoiceId],
  );
  const lines: ReceiptLine[] = linesResult.rows.map((r) => ({
    name: r.head_name, term: r.term_no, amountPaise: r.amount, amountDisplay: formatInr(r.amount),
  }));
  const total = lines.reduce((sum, l) => sum + l.amountPaise, 0);

  return {
    school: { name: invoice.school_name, address: invoice.school_address, receiptFooter: invoice.receipt_footer },
    headingText: "Fee bill",
    docNo: invoice.invoice_no,
    docDate: invoice.issued_on,
    dueDate: invoice.due_on,
    // Frozen at issue time, same as the Django version — a reprint after
    // DPDP de-identification must still show what the bill actually said.
    student: { fullName: invoice.student_name_at_issue, admissionNo: "" },
    classLabel: invoice.class_at_issue,
    lines,
    totalPaise: total,
    totalDisplay: formatInr(total),
    totalWords: amountInWords(total),
  };
}
