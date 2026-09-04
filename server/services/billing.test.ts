import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../db/index.js";
import {
  BillingError, carryForwardArrears, generateCharges, issueInvoice, outstandingSummary,
} from "./billing.js";
import { createSchool, resetDb } from "../tests/helpers.js";
import {
  createAcademicYear, createClassLevel, createEnrollment, createFeeHead,
  createFeeStructureLine, createSection, createStudent, resetFeeDomain,
} from "../tests/fixtures.js";

let school: any;
let year: any;
let classLevel: any;
let section: any;
let tuition: any;
let admissionFee: any;
let transport: any;

beforeEach(async () => {
  await resetFeeDomain();
  await resetDb();

  school = await createSchool({ short_code: "bill-test" });
  year = await createAcademicYear(school.id);
  classLevel = await createClassLevel(school.id);
  section = await createSection(school.id, year.id, classLevel.id);

  tuition = await createFeeHead(school.id, { name: "Tuition fee", display_order: 1 });
  admissionFee = await createFeeHead(school.id, {
    name: "Admission fee", is_one_time: true, display_order: 2,
  });
  transport = await createFeeHead(school.id, {
    name: "Transport", is_optional: true, display_order: 3,
  });

  await createFeeStructureLine(school.id, year.id, classLevel.id, tuition.id, { amount: 4000000 });
  await createFeeStructureLine(school.id, year.id, classLevel.id, admissionFee.id, { amount: 1500000 });
  await createFeeStructureLine(school.id, year.id, classLevel.id, transport.id, { amount: 800000 });
});

afterAll(async () => {
  await pool.end();
});

async function newStudentEnrollment(admissionType = "new") {
  const student = await createStudent(school.id);
  const enrollment = await createEnrollment(
    school.id, student.id, year.id, classLevel.id, section.id, { admission_type: admissionType },
  );
  return { student, enrollment };
}

describe("generateCharges", () => {
  it("snapshots the fee structure onto a new admission, including the one-time fee", async () => {
    const { enrollment } = await newStudentEnrollment("new");
    const charges = await generateCharges(enrollment.id);

    // Tuition + Admission fee; Transport is optional and wasn't opted into.
    expect(charges).toHaveLength(2);
    const names = (charges as any[]).map((c) => c.head_name).sort();
    expect(names).toEqual(["Admission fee", "Tuition fee"]);
  });

  it("skips the one-time fee for a continuing student", async () => {
    const { enrollment } = await newStudentEnrollment("carry_over");
    const charges = await generateCharges(enrollment.id);
    const names = (charges as any[]).map((c) => c.head_name);
    expect(names).not.toContain("Admission fee");
    expect(names).toContain("Tuition fee");
  });

  it("includes an optional head only when opted into", async () => {
    const { enrollment } = await newStudentEnrollment("carry_over");
    const charges = await generateCharges(enrollment.id, { optionalHeadIds: [transport.id] });
    const names = (charges as any[]).map((c) => c.head_name);
    expect(names).toContain("Transport");
  });

  it("is idempotent — running twice never duplicates charges", async () => {
    const { enrollment } = await newStudentEnrollment("new");
    await generateCharges(enrollment.id);
    const second = await generateCharges(enrollment.id);
    expect(second).toHaveLength(0);

    const count = await pool.query(`SELECT COUNT(*) FROM charges WHERE enrollment_id = $1`,
      [enrollment.id]);
    expect(Number(count.rows[0].count)).toBe(2); // tuition + admission, not doubled
  });

  it("freezes the amount and head name onto the charge (a later price edit doesn't retroact)", async () => {
    const { enrollment } = await newStudentEnrollment("carry_over");
    await generateCharges(enrollment.id);

    await pool.query(`UPDATE fee_structures SET amount = 9999900 WHERE fee_head_id = $1`,
      [tuition.id]);

    const charge = await pool.query(
      `SELECT amount FROM charges WHERE enrollment_id = $1 AND head_name = 'Tuition fee'`,
      [enrollment.id],
    );
    expect(charge.rows[0].amount).toBe(4000000); // unchanged, not the new 9999900
  });

  it("refuses to post charges into a closed academic year", async () => {
    const closedYear = await createAcademicYear(school.id, { name: "2025-26", status: "closed" });
    const closedSection = await createSection(school.id, closedYear.id, classLevel.id);
    const student = await createStudent(school.id);
    const enrollment = await createEnrollment(
      school.id, student.id, closedYear.id, classLevel.id, closedSection.id,
    );

    await expect(generateCharges(enrollment.id)).rejects.toThrow(BillingError);
  });
});

describe("carryForwardArrears", () => {
  it("moves an unpaid balance into the new year as a single arrear charge", async () => {
    const { enrollment: fromEnrollment } = await newStudentEnrollment("new");
    await generateCharges(fromEnrollment.id); // owes 55,00,000 paise (₹55,000) total unpaid

    const nextYear = await createAcademicYear(school.id, { name: "2027-28", starts_on: "2027-06-01", ends_on: "2028-03-31" });
    const nextSection = await createSection(school.id, nextYear.id, classLevel.id);
    const student = (await pool.query(`SELECT student_id FROM enrollments WHERE id = $1`,
      [fromEnrollment.id])).rows[0].student_id;
    const toEnrollment = await createEnrollment(
      school.id, student, nextYear.id, classLevel.id, nextSection.id, { admission_type: "carry_over" },
    );

    const arrear = await carryForwardArrears({
      fromEnrollmentId: fromEnrollment.id, toEnrollmentId: toEnrollment.id,
    });
    expect((arrear as any).amount).toBe(5500000); // 40,000 + 15,000 tuition+admission, unpaid
    expect((arrear as any).is_arrear).toBe(true);
  });

  it("returns null when there's nothing outstanding to carry forward", async () => {
    const { enrollment: fromEnrollment } = await newStudentEnrollment("new");
    // No charges generated at all -> balance is zero.
    const nextYear = await createAcademicYear(school.id, { name: "2027-28", starts_on: "2027-06-01", ends_on: "2028-03-31" });
    const nextSection = await createSection(school.id, nextYear.id, classLevel.id);
    const student = (await pool.query(`SELECT student_id FROM enrollments WHERE id = $1`,
      [fromEnrollment.id])).rows[0].student_id;
    const toEnrollment = await createEnrollment(
      school.id, student, nextYear.id, classLevel.id, nextSection.id,
    );

    const arrear = await carryForwardArrears({
      fromEnrollmentId: fromEnrollment.id, toEnrollmentId: toEnrollment.id,
    });
    expect(arrear).toBeNull();
  });

  it("is idempotent — running twice returns the same arrear row, not a second one", async () => {
    const { enrollment: fromEnrollment } = await newStudentEnrollment("new");
    await generateCharges(fromEnrollment.id);
    const nextYear = await createAcademicYear(school.id, { name: "2027-28", starts_on: "2027-06-01", ends_on: "2028-03-31" });
    const nextSection = await createSection(school.id, nextYear.id, classLevel.id);
    const student = (await pool.query(`SELECT student_id FROM enrollments WHERE id = $1`,
      [fromEnrollment.id])).rows[0].student_id;
    const toEnrollment = await createEnrollment(
      school.id, student, nextYear.id, classLevel.id, nextSection.id,
    );

    const first = await carryForwardArrears({
      fromEnrollmentId: fromEnrollment.id, toEnrollmentId: toEnrollment.id,
    });
    const second = await carryForwardArrears({
      fromEnrollmentId: fromEnrollment.id, toEnrollmentId: toEnrollment.id,
    });
    expect((first as any).id).toBe((second as any).id);

    const count = await pool.query(`SELECT COUNT(*) FROM charges WHERE enrollment_id = $1 AND is_arrear = true`,
      [toEnrollment.id]);
    expect(Number(count.rows[0].count)).toBe(1);
  });
});

describe("issueInvoice", () => {
  it("bundles unbilled charges and assigns a sequential invoice number", async () => {
    const { enrollment } = await newStudentEnrollment("new");
    await generateCharges(enrollment.id);

    const invoice = await issueInvoice(enrollment.id) as any;
    expect(invoice.invoice_no).toMatch(/^INV\/\d{4}-\d{2}\/\d{5}$/);

    const charges = await pool.query(`SELECT invoice_id FROM charges WHERE enrollment_id = $1`,
      [enrollment.id]);
    expect(charges.rows.every((c) => c.invoice_id === invoice.id)).toBe(true);
  });

  it("only bills what hasn't already been invoiced", async () => {
    const { enrollment } = await newStudentEnrollment("new");
    await generateCharges(enrollment.id);
    await issueInvoice(enrollment.id);

    await expect(issueInvoice(enrollment.id)).rejects.toThrow(BillingError);
  });

  it("issues sequential, gapless numbers across invoices in the same fiscal year", async () => {
    const { enrollment: e1 } = await newStudentEnrollment("new");
    const { enrollment: e2 } = await newStudentEnrollment("new");
    await generateCharges(e1.id);
    await generateCharges(e2.id);

    const inv1 = await issueInvoice(e1.id) as any;
    const inv2 = await issueInvoice(e2.id) as any;
    const seq1 = Number(inv1.invoice_no.split("/").pop());
    const seq2 = Number(inv2.invoice_no.split("/").pop());
    expect(seq2).toBe(seq1 + 1);
  });

  it("freezes the student name and class onto the invoice", async () => {
    const { enrollment } = await newStudentEnrollment("new");
    await generateCharges(enrollment.id);
    const invoice = await issueInvoice(enrollment.id) as any;
    expect(invoice.class_at_issue).toBe("VIII-A");
  });
});

describe("outstandingSummary", () => {
  it("lists only enrollments with a positive balance, largest first", async () => {
    const { enrollment: bigDebtor } = await newStudentEnrollment("new");
    await generateCharges(bigDebtor.id); // 55,000 owed

    const { enrollment: smallDebtor } = await newStudentEnrollment("carry_over");
    await generateCharges(smallDebtor.id); // 40,000 owed (no admission fee)

    const { enrollment: noCharges } = await newStudentEnrollment("carry_over");
    void noCharges; // zero balance, must not appear

    const summary = await outstandingSummary(year.id);
    expect(summary.count).toBe(2);
    expect(summary.rows[0].balance).toBeGreaterThanOrEqual(summary.rows[1].balance);
    expect(summary.total).toBe(summary.rows[0].balance + summary.rows[1].balance);
  });
});
