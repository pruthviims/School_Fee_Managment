import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../db/index.js";
import { generateCharges, issueInvoice } from "./billing.js";
import { recordPayment } from "./collection.js";
import { ReceiptError, amountInWords, formatInr, getInvoiceData, getReceiptData } from "./receipts.js";
import { createSchool, createUser, resetDb } from "../tests/helpers.js";
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

  school = await createSchool({ short_code: "receipt-test", address: "48 MG Road, Bengaluru" });
  year = await createAcademicYear(school.id);
  classLevel = await createClassLevel(school.id);
  section = await createSection(school.id, year.id, classLevel.id);

  const tuition = await createFeeHead(school.id, { name: "Tuition fee" });
  await createFeeStructureLine(school.id, year.id, classLevel.id, tuition.id, { amount: 4000000 }); // ₹40,000
});

afterAll(async () => {
  await pool.end();
});

async function newEnrollment() {
  const student = await createStudent(school.id, { full_name: "Ravi Kumar" });
  return createEnrollment(school.id, student.id, year.id, classLevel.id, section.id);
}

describe("formatInr", () => {
  it("groups digits the Indian way", () => {
    expect(formatInr(123456700)).toBe("12,34,567.00"); // 12,34,567 rupees
    expect(formatInr(100000)).toBe("1,000.00");
    expect(formatInr(50000)).toBe("500.00");
  });
  it("handles a negative amount", () => {
    expect(formatInr(-150000)).toBe("-1,500.00");
  });
  it("shows a non-zero paise part", () => {
    expect(formatInr(150050)).toBe("1,500.50");
  });
});

describe("amountInWords", () => {
  it("uses lakh and crore, not million", () => {
    expect(amountInWords(123456700)).toBe("Twelve lakh thirty-four thousand five hundred sixty-seven rupees only");
  });
  it("handles zero", () => {
    expect(amountInWords(0)).toBe("Zero rupees only");
  });
  it("includes a paise remainder", () => {
    expect(amountInWords(150050)).toBe("One thousand five hundred rupees and fifty paise only");
  });
  it("handles a simple thousand", () => {
    expect(amountInWords(4000000)).toBe("Forty thousand rupees only");
  });
});

describe("getReceiptData", () => {
  it("assembles the school, student, and paid line items for a single payment", async () => {
    const enrollment = await newEnrollment();
    await generateCharges(enrollment.id);
    const payment = await recordPayment({
      enrollmentId: enrollment.id, amount: 1500000, mode: "cash",
    }) as any;

    const data = await getReceiptData(payment.id);
    expect(data.school.name).toBe(school.name);
    expect(data.school.address).toBe("48 MG Road, Bengaluru");
    expect(data.student.fullName).toBe("Ravi Kumar");
    expect(data.classLabel).toContain("-A");
    expect(data.docNo).toBe(payment.receipt_no);
    expect(data.totalPaise).toBe(1500000);
    expect(data.totalDisplay).toBe("15,000.00");
    expect(data.lines).toHaveLength(1);
    expect(data.lines[0].name).toBe("Tuition fee");
    expect(data.lines[0].amountPaise).toBe(1500000); // the allocated amount, not the full charge
    expect(data.priorPayments).toHaveLength(0);
  });

  it("includes the year's gross fee and any concession, alongside the payment itself", async () => {
    const enrollment = await newEnrollment();
    await generateCharges(enrollment.id); // 40,000 gross
    const approver = await createUser("owner@receipt-test.example", "x".repeat(14));
    await pool.query(
      `INSERT INTO concessions (school_id, enrollment_id, reason, amount, approved_by)
       VALUES ($1, $2, 'sibling', 1000000, $3)`,
      [school.id, enrollment.id, approver.id],
    ); // 10,000 concession
    const payment = await recordPayment({
      enrollmentId: enrollment.id, amount: 1500000, mode: "cash",
    }) as any;

    const data = await getReceiptData(payment.id);
    expect(data.grossPaise).toBe(4000000);
    expect(data.concessionPaise).toBe(1000000);
    expect(data.netPaise).toBe(3000000);
  });

  it("shows an unallocated remainder as an Advance line", async () => {
    const enrollment = await newEnrollment();
    await generateCharges(enrollment.id); // 40,000 owed
    const payment = await recordPayment({
      enrollmentId: enrollment.id, amount: 5000000, mode: "cash", // pays 50,000 — 10,000 advance
    }) as any;

    const data = await getReceiptData(payment.id);
    const advanceLine = data.lines.find((l) => l.name.includes("Advance"));
    expect(advanceLine).toBeDefined();
    expect(advanceLine!.amountPaise).toBe(1000000);
  });

  it("lists earlier payments as prior instalments, oldest first, excluding itself", async () => {
    const enrollment = await newEnrollment();
    await generateCharges(enrollment.id);
    const first = await recordPayment({ enrollmentId: enrollment.id, amount: 1000000, mode: "cash" }) as any;
    await new Promise((r) => setTimeout(r, 10)); // ensure created_at ordering is unambiguous
    const second = await recordPayment({ enrollmentId: enrollment.id, amount: 1500000, mode: "upi" }) as any;

    const secondData = await getReceiptData(second.id);
    expect(secondData.priorPayments).toHaveLength(1);
    expect(secondData.priorPayments[0].receiptNo).toBe(first.receipt_no);
    expect(secondData.priorPayments[0].amountPaise).toBe(1000000);

    const firstData = await getReceiptData(first.id);
    expect(firstData.priorPayments).toHaveLength(0); // nothing came before the first payment
  });

  it("computes the balance as of that specific payment, not today's total", async () => {
    const enrollment = await newEnrollment();
    await generateCharges(enrollment.id); // 40,000 owed
    const first = await recordPayment({ enrollmentId: enrollment.id, amount: 1500000, mode: "cash" }) as any;
    await new Promise((r) => setTimeout(r, 10));
    const second = await recordPayment({ enrollmentId: enrollment.id, amount: 1000000, mode: "cash" }) as any;

    const firstData = await getReceiptData(first.id);
    expect(firstData.balanceAfterPaise).toBe(4000000 - 1500000); // only the first payment counted

    const secondData = await getReceiptData(second.id);
    expect(secondData.balanceAfterPaise).toBe(4000000 - 1500000 - 1000000); // both counted
  });

  it("throws for a payment that doesn't exist", async () => {
    await expect(getReceiptData("00000000-0000-0000-0000-000000000000")).rejects.toThrow(ReceiptError);
  });
});

describe("getInvoiceData", () => {
  it("assembles invoice line items and freezes the student/class label", async () => {
    const enrollment = await newEnrollment();
    await generateCharges(enrollment.id);
    const invoice = await issueInvoice(enrollment.id) as any;

    const data = await getInvoiceData(invoice.id);
    expect(data.docNo).toBe(invoice.invoice_no);
    expect(data.student.fullName).toBe("Ravi Kumar");
    expect(data.lines).toHaveLength(1);
    expect(data.lines[0].name).toBe("Tuition fee");
    expect(data.totalPaise).toBe(4000000);
    expect(data.totalWords).toContain("Forty thousand");
  });

  it("throws for an invoice that doesn't exist", async () => {
    await expect(getInvoiceData("00000000-0000-0000-0000-000000000000")).rejects.toThrow(ReceiptError);
  });
});
