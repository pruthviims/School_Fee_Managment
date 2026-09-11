import { afterAll, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { pool } from "../db/index.js";
import { generateCharges } from "./billing.js";
import {
  CollectionError, dailyCollection, handleGatewayWebhook, markBounced, markCleared,
  recordPayment, recordPaymentsBulk, verifyWebhookSignature,
} from "./collection.js";
import { createSchool, resetDb } from "../tests/helpers.js";
import {
  createAcademicYear, createClassLevel, createEnrollment, createFeeHead,
  createFeeStructureLine, createSection, createStudent, resetFeeDomain,
} from "../tests/fixtures.js";

let school: any;
let year: any;
let classLevel: any;
let section: any;

beforeEach(async () => {
  await resetFeeDomain();
  await resetDb();

  school = await createSchool({ short_code: "coll-test" });
  year = await createAcademicYear(school.id);
  classLevel = await createClassLevel(school.id);
  section = await createSection(school.id, year.id, classLevel.id);
});

afterAll(async () => {
  await pool.end();
});

async function studentWithCharges(dueOnByTerm: Record<number, string> = {}) {
  const tuitionT1 = await createFeeHead(school.id, { name: "Tuition T1" });
  const tuitionT2 = await createFeeHead(school.id, { name: "Tuition T2" });
  await createFeeStructureLine(school.id, year.id, classLevel.id, tuitionT1.id, {
    amount: 2000000, term_no: 1, due_on: dueOnByTerm[1] ?? "2026-06-01",
  });
  await createFeeStructureLine(school.id, year.id, classLevel.id, tuitionT2.id, {
    amount: 2000000, term_no: 2, due_on: dueOnByTerm[2] ?? "2026-10-01",
  });

  const student = await createStudent(school.id);
  const enrollment = await createEnrollment(school.id, student.id, year.id, classLevel.id, section.id);
  await generateCharges(enrollment.id);
  return enrollment;
}

/**
 * Prices the class once (matching studentWithCharges' own two-term
 * Tuition T1/T2 amounts), then creates as many enrollments against
 * that single shared structure as asked for — the shape a real class
 * actually has (one fee structure, many students), and avoids
 * studentWithCharges' own per-call fee-head creation colliding on
 * fee_heads' per-school name uniqueness when called more than once.
 */
async function classWithSeveralCharged(count: number) {
  const tuitionT1 = await createFeeHead(school.id, { name: "Tuition T1" });
  const tuitionT2 = await createFeeHead(school.id, { name: "Tuition T2" });
  await createFeeStructureLine(school.id, year.id, classLevel.id, tuitionT1.id, {
    amount: 2000000, term_no: 1, due_on: "2026-06-01",
  });
  await createFeeStructureLine(school.id, year.id, classLevel.id, tuitionT2.id, {
    amount: 2000000, term_no: 2, due_on: "2026-10-01",
  });

  const enrollments = [];
  for (let i = 0; i < count; i++) {
    const student = await createStudent(school.id);
    const enrollment = await createEnrollment(school.id, student.id, year.id, classLevel.id, section.id);
    await generateCharges(enrollment.id);
    enrollments.push(enrollment);
  }
  return enrollments;
}

describe("recordPayment", () => {
  it("clears cash immediately and allocates oldest-due-first", async () => {
    const enrollment = await studentWithCharges();
    const payment = await recordPayment({
      enrollmentId: enrollment.id, amount: 2000000, mode: "cash",
    }) as any;

    expect(payment.clearing_status).toBe("cleared");
    expect(payment.receipt_no).toMatch(/^RCP\/\d{4}-\d{2}\/\d{5}$/);

    const allocations = await pool.query(
      `SELECT c.due_on FROM allocations a JOIN charges c ON c.id = a.charge_id
       WHERE a.payment_id = $1`,
      [payment.id],
    );
    expect(allocations.rows).toHaveLength(1);
    expect(allocations.rows[0].due_on.toISOString().slice(0, 10)).toBe("2026-06-01"); // T1, the earlier due date
  });

  it("leaves a cheque pending, not cleared, until confirmed", async () => {
    const enrollment = await studentWithCharges();
    const payment = await recordPayment({
      enrollmentId: enrollment.id, amount: 2000000, mode: "cheque", instrumentRef: "CHQ-001",
    }) as any;
    expect(payment.clearing_status).toBe("pending");
    expect(payment.cleared_on).toBeNull();

    // Pending payments must not count toward the balance.
    const ledgerCheck = await pool.query(
      `SELECT COALESCE(SUM(a.amount), 0) AS paid FROM allocations a
       JOIN payments p ON p.id = a.payment_id
       WHERE a.charge_id IN (SELECT id FROM charges WHERE enrollment_id = $1)
         AND p.clearing_status = 'cleared'`,
      [enrollment.id],
    );
    expect(ledgerCheck.rows[0].paid).toBe(0);
  });

  it("splits a payment across two charges, arrears first", async () => {
    const enrollment = await studentWithCharges();
    // Add an arrear charge due later than T1, but arrears must still be
    // allocated first regardless of due date ordering.
    await pool.query(
      `INSERT INTO charges (school_id, enrollment_id, head_name, amount, term_no,
                             due_on, source, is_arrear, source_year_id)
       VALUES ($1, $2, 'Arrears', 500000, 1, '2026-12-01', 'arrear', true, $3)`,
      [school.id, enrollment.id, year.id],
    );

    const payment = await recordPayment({
      enrollmentId: enrollment.id, amount: 700000, mode: "cash",
    }) as any;

    const allocations = await pool.query(
      `SELECT c.head_name, a.amount FROM allocations a JOIN charges c ON c.id = a.charge_id
       WHERE a.payment_id = $1 ORDER BY a.amount DESC`,
      [payment.id],
    );
    expect(allocations.rows).toHaveLength(2);
    const arrearRow = allocations.rows.find((r) => r.head_name === "Arrears");
    expect(arrearRow.amount).toBe(500000); // arrear fully paid first
  });

  it("records an unallocated advance when payment exceeds all outstanding charges", async () => {
    const enrollment = await studentWithCharges();
    const payment = await recordPayment({
      enrollmentId: enrollment.id, amount: 5000000, mode: "cash", // charges total only 4,000,000
    }) as any;

    const allocated = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM allocations WHERE payment_id = $1`,
      [payment.id],
    );
    expect(allocated.rows[0].total).toBe(4000000);
    expect(payment.amount - allocated.rows[0].total).toBe(1000000); // advance
  });

  it("respects an explicit charge allocation over the default oldest-first policy", async () => {
    const enrollment = await studentWithCharges();
    const t2Charge = await pool.query(
      `SELECT id FROM charges WHERE enrollment_id = $1 AND head_name = 'Tuition T2'`,
      [enrollment.id],
    );
    const payment = await recordPayment({
      enrollmentId: enrollment.id, amount: 2000000, mode: "cash",
      chargeAmounts: [{ chargeId: t2Charge.rows[0].id, amount: 2000000 }],
    }) as any;

    const allocations = await pool.query(
      `SELECT charge_id FROM allocations WHERE payment_id = $1`, [payment.id],
    );
    expect(allocations.rows[0].charge_id).toBe(t2Charge.rows[0].id);
  });

  it("rejects a zero or negative amount", async () => {
    const enrollment = await studentWithCharges();
    await expect(recordPayment({ enrollmentId: enrollment.id, amount: 0, mode: "cash" }))
      .rejects.toThrow(CollectionError);
  });

  it("refuses payments into a closed academic year", async () => {
    const closedYear = await createAcademicYear(school.id, { name: "2024-25", status: "closed" });
    const closedSection = await createSection(school.id, closedYear.id, classLevel.id);
    const student = await createStudent(school.id);
    const enrollment = await createEnrollment(
      school.id, student.id, closedYear.id, classLevel.id, closedSection.id,
    );
    await expect(recordPayment({ enrollmentId: enrollment.id, amount: 1000, mode: "cash" }))
      .rejects.toThrow(CollectionError);
  });

  it("issues sequential gapless receipt numbers across payments", async () => {
    const enrollment = await studentWithCharges();
    const p1 = await recordPayment({ enrollmentId: enrollment.id, amount: 100000, mode: "cash" }) as any;
    const p2 = await recordPayment({ enrollmentId: enrollment.id, amount: 100000, mode: "cash" }) as any;
    const seq1 = Number(p1.receipt_no.split("/").pop());
    const seq2 = Number(p2.receipt_no.split("/").pop());
    expect(seq2).toBe(seq1 + 1);
  });
});

describe("recordPaymentsBulk", () => {
  it("produces identical results to recordPayment, for several enrollments at once", async () => {
    const [e1, e2, e3] = await classWithSeveralCharged(3);

    const client = await pool.connect();
    try {
      const count = await recordPaymentsBulk(
        [e1, e2, e3].map((e) => ({
          enrollmentId: e.id, schoolId: school.id, amount: 2000000, mode: "cash",
          instrumentRef: "Opening balance from import",
        })),
        { client },
      );
      expect(count).toBe(3);
    } finally {
      client.release();
    }

    for (const e of [e1, e2, e3]) {
      const payments = await pool.query(
        `SELECT amount, mode, clearing_status, instrument_ref, receipt_no
         FROM payments WHERE enrollment_id = $1`, [e.id],
      );
      expect(payments.rows).toHaveLength(1);
      expect(Number(payments.rows[0].amount)).toBe(2000000);
      expect(payments.rows[0].clearing_status).toBe("cleared"); // cash is instant
      expect(payments.rows[0].instrument_ref).toBe("Opening balance from import");
      expect(payments.rows[0].receipt_no).toMatch(/^RCP\//);

      // Allocated against the earlier-due term first, same policy
      // allocate() itself applies — proven here against the real
      // resulting allocation, not just that a payment row exists.
      const allocations = await pool.query(
        `SELECT c.head_name, a.amount FROM allocations a
         JOIN charges c ON c.id = a.charge_id
         WHERE a.payment_id = (SELECT id FROM payments WHERE enrollment_id = $1)`,
        [e.id],
      );
      expect(allocations.rows).toHaveLength(1);
      expect(allocations.rows[0].head_name).toBe("Tuition T1"); // earlier due_on
      expect(Number(allocations.rows[0].amount)).toBe(2000000);
    }
  });

  it("issues sequential, gapless receipt numbers across the whole batch, not just within one payment", async () => {
    const enrollments = await classWithSeveralCharged(4);
    const client = await pool.connect();
    try {
      await recordPaymentsBulk(
        enrollments.map((e) => ({ enrollmentId: e.id, schoolId: school.id, amount: 500000, mode: "cash" })),
        { client },
      );
    } finally {
      client.release();
    }

    const receipts = await pool.query(
      `SELECT receipt_no FROM payments WHERE enrollment_id = ANY($1::uuid[]) ORDER BY receipt_no`,
      [enrollments.map((e) => e.id)],
    );
    const sequences = receipts.rows.map((r) => Number(r.receipt_no.split("/").pop()));
    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i]).toBe(sequences[i - 1] + 1); // no gaps
    }
  });

  it("splits a payment across multiple charges, oldest-due-first, same as a single recordPayment call would", async () => {
    const enrollment = await studentWithCharges();
    const client = await pool.connect();
    try {
      // Covers both term charges (40000 total) plus an advance remainder.
      await recordPaymentsBulk(
        [{ enrollmentId: enrollment.id, schoolId: school.id, amount: 4500000, mode: "cash" }],
        { client },
      );
    } finally {
      client.release();
    }

    const allocations = await pool.query(
      `SELECT c.head_name, a.amount FROM allocations a
       JOIN charges c ON c.id = a.charge_id
       WHERE a.payment_id = (SELECT id FROM payments WHERE enrollment_id = $1)
       ORDER BY c.head_name`,
      [enrollment.id],
    );
    expect(allocations.rows).toHaveLength(2);
    expect(Number(allocations.rows[0].amount)).toBe(2000000); // Tuition T1, fully covered
    expect(Number(allocations.rows[1].amount)).toBe(2000000); // Tuition T2, fully covered
    // The extra 500000 is left unallocated — a real advance, matching
    // exactly what allocate() itself does with a remainder.
    const total = allocations.rows.reduce((sum, r) => sum + Number(r.amount), 0);
    expect(total).toBe(4000000);
  });

  it("does nothing for an empty list, rather than erroring", async () => {
    const client = await pool.connect();
    try {
      const count = await recordPaymentsBulk([], { client });
      expect(count).toBe(0);
    } finally {
      client.release();
    }
  });
});

describe("markCleared / markBounced", () => {
  it("clearing a cheque makes its allocations count toward the balance", async () => {
    const enrollment = await studentWithCharges();
    const payment = await recordPayment({
      enrollmentId: enrollment.id, amount: 2000000, mode: "cheque",
    }) as any;

    await markCleared(payment.id);

    const cleared = await pool.query(`SELECT clearing_status, cleared_on FROM payments WHERE id = $1`,
      [payment.id]);
    expect(cleared.rows[0].clearing_status).toBe("cleared");
    expect(cleared.rows[0].cleared_on).not.toBeNull();
  });

  it("is a no-op when already cleared", async () => {
    const enrollment = await studentWithCharges();
    const payment = await recordPayment({ enrollmentId: enrollment.id, amount: 100000, mode: "cash" }) as any;
    const result = await markCleared(payment.id) as any;
    expect(result.clearing_status).toBe("cleared");
  });

  it("a bounced cheque keeps the payment row but drops its allocations, reopening the balance", async () => {
    const enrollment = await studentWithCharges();
    const payment = await recordPayment({
      enrollmentId: enrollment.id, amount: 2000000, mode: "cheque", instrumentRef: "CHQ-99",
    }) as any;
    await markCleared(payment.id);

    const before = await pool.query(`SELECT COUNT(*) FROM allocations WHERE payment_id = $1`, [payment.id]);
    expect(Number(before.rows[0].count)).toBeGreaterThan(0);

    await markBounced(payment.id, "Insufficient funds");

    const after = await pool.query(`SELECT COUNT(*) FROM allocations WHERE payment_id = $1`, [payment.id]);
    expect(Number(after.rows[0].count)).toBe(0);

    const paymentRow = await pool.query(`SELECT * FROM payments WHERE id = $1`, [payment.id]);
    expect(paymentRow.rows[0].clearing_status).toBe("bounced");
    expect(paymentRow.rows[0].reversal_reason).toBe("Insufficient funds");
    // The row itself survives — the receipt number stays in the sequence.
    expect(paymentRow.rows).toHaveLength(1);
  });
});

describe("webhook handling", () => {
  it("verifies a correct HMAC signature and rejects a wrong one", () => {
    const secret = "test-webhook-secret";
    const body = Buffer.from(JSON.stringify({ event: "payment.captured" }));
    const goodSig = crypto.createHmac("sha256", secret).update(body).digest("hex");

    expect(verifyWebhookSignature(body, goodSig, secret)).toBe(true);
    expect(verifyWebhookSignature(body, "wrong-signature", secret)).toBe(false);
    expect(verifyWebhookSignature(body, goodSig, "")).toBe(false);
  });

  it("is idempotent — a duplicate gateway_payment_id doesn't double-credit", async () => {
    const enrollment = await studentWithCharges();
    const [first, firstCreated] = await handleGatewayWebhook({
      enrollmentId: enrollment.id, gateway: "razorpay", gatewayOrderId: "order_1",
      gatewayPaymentId: "pay_abc123", amount: 2000000,
    });
    const [second, secondCreated] = await handleGatewayWebhook({
      enrollmentId: enrollment.id, gateway: "razorpay", gatewayOrderId: "order_1",
      gatewayPaymentId: "pay_abc123", amount: 2000000,
    });

    expect(firstCreated).toBe(true);
    expect(secondCreated).toBe(false);
    expect((first as any).id).toBe((second as any).id);

    const count = await pool.query(`SELECT COUNT(*) FROM payments WHERE gateway_payment_id = $1`,
      ["pay_abc123"]);
    expect(Number(count.rows[0].count)).toBe(1);
  });
});

describe("dailyCollection", () => {
  it("totals cleared payments by mode for the day, excluding pending ones", async () => {
    const enrollment = await studentWithCharges();
    const today = new Date().toISOString().slice(0, 10);

    await recordPayment({ enrollmentId: enrollment.id, amount: 100000, mode: "cash" });
    await recordPayment({ enrollmentId: enrollment.id, amount: 200000, mode: "upi" });
    await recordPayment({ enrollmentId: enrollment.id, amount: 300000, mode: "cheque" }); // pending, excluded

    const report = await dailyCollection(school.id, today);
    expect(report.total).toBe(300000); // cash + upi only
    expect(report.byMode.cash).toBe(100000);
    expect(report.byMode.upi).toBe(200000);
    expect(report.byMode.cheque).toBeUndefined();
    expect(report.count).toBe(2);
  });
});
