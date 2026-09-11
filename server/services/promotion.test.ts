import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../db/index.js";
import { generateCharges } from "./billing.js";
import { recordPayment } from "./collection.js";
import { getEnrollmentLedger } from "./ledger.js";
import {
  PromotionError, assignSections, commit, isActionable, preview, previewSummary, reverseBatch,
} from "./promotion.js";
import { createSchool, resetDb } from "../tests/helpers.js";
import {
  createAcademicYear, createClassLevel, createEnrollment, createFeeHead,
  createFeeStructureLine, createSection, createStudent, resetFeeDomain,
} from "../tests/fixtures.js";

let school: any;
let fromYear: any;
let toYear: any;
let classVIII: any;
let classIX: any;
let sectionVIII_A: any;
let sectionIX_A: any;

beforeEach(async () => {
  await resetFeeDomain();
  await resetDb();

  school = await createSchool({ short_code: "promo-test" });
  fromYear = await createAcademicYear(school.id, {
    name: "2025-26", starts_on: "2025-06-01", ends_on: "2026-03-31",
  });
  toYear = await createAcademicYear(school.id, {
    name: "2026-27", starts_on: "2026-06-01", ends_on: "2027-03-31",
  });

  classVIII = await createClassLevel(school.id, { name: "VIII", ladder_order: 8 });
  classIX = await createClassLevel(school.id, { name: "IX", ladder_order: 9 });
  sectionVIII_A = await createSection(school.id, fromYear.id, classVIII.id, "A");
  sectionIX_A = await createSection(school.id, toYear.id, classIX.id, "A");

  const tuition = await createFeeHead(school.id, { name: "Tuition" });
  await createFeeStructureLine(school.id, fromYear.id, classVIII.id, tuition.id, { amount: 4000000 });
  await createFeeStructureLine(school.id, toYear.id, classIX.id, tuition.id, { amount: 4200000 });
});

afterAll(async () => {
  await pool.end();
});

async function studentInVIII(overrides = {}) {
  const student = await createStudent(school.id, overrides);
  const enrollment = await createEnrollment(
    school.id, student.id, fromYear.id, classVIII.id, sectionVIII_A.id,
  );
  return { student, enrollment };
}

describe("preview", () => {
  it("proposes a straightforward promotion to the next class", async () => {
    const { enrollment } = await studentInVIII();
    const result = await preview({ fromYearId: fromYear.id, toYearId: toYear.id });

    expect(result.moves).toHaveLength(1);
    expect(result.moves[0].enrollmentId).toBe(enrollment.id);
    expect(result.moves[0].toClassName).toBe("IX");
    expect(isActionable(result.moves[0])).toBe(true);
  });

  it("includes guardian name and phone, so two students sharing a name can be told apart", async () => {
    await studentInVIII({ full_name: "Divya Mishra", guardian_name: "Simran Mishra",
      guardian_phone: "9465341213" });
    await studentInVIII({ full_name: "Divya Mishra", guardian_name: "Rohan Mishra",
      guardian_phone: "9812345670" });
    const result = await preview({ fromYearId: fromYear.id, toYearId: toYear.id });

    expect(result.moves).toHaveLength(2);
    const guardianNames = result.moves.map((m: any) => m.guardianName).sort();
    expect(guardianNames).toEqual(["Rohan Mishra", "Simran Mishra"]);
    const guardianPhones = result.moves.map((m: any) => m.guardianPhone).sort();
    expect(guardianPhones).toEqual(["9465341213", "9812345670"]);
  });

  it("blocks a detained student instead of proposing a move", async () => {
    const { enrollment } = await studentInVIII();
    await pool.query(`UPDATE enrollments SET outcome = 'detained' WHERE id = $1`, [enrollment.id]);

    const result = await preview({ fromYearId: fromYear.id, toYearId: toYear.id });
    expect(result.moves).toHaveLength(0);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].blockedReason).toContain("Detained");
  });

  it("routes a terminal-class student to graduating, not moves", async () => {
    const terminalClass = await createClassLevel(school.id, {
      name: "2nd PU", ladder_order: 14, is_terminal: true,
    });
    const terminalSection = await createSection(school.id, fromYear.id, terminalClass.id, "A");
    const student = await createStudent(school.id);
    await createEnrollment(school.id, student.id, fromYear.id, terminalClass.id, terminalSection.id);

    const result = await preview({ fromYearId: fromYear.id, toYearId: toYear.id });
    expect(result.moves).toHaveLength(0);
    expect(result.graduating).toHaveLength(1);
    expect(result.graduating[0].blockedReason).toContain("alumni");
  });

  it("blocks when there's no class configured above the current one", async () => {
    const topClass = await createClassLevel(school.id, { name: "X", ladder_order: 50 }); // nothing at 51
    const topSection = await createSection(school.id, fromYear.id, topClass.id, "A");
    const student = await createStudent(school.id);
    await createEnrollment(school.id, student.id, fromYear.id, topClass.id, topSection.id);

    const result = await preview({ fromYearId: fromYear.id, toYearId: toYear.id });
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].blockedReason).toContain("No class configured above");
  });

  it("flags requires_explicit_optin and does not auto-carry a stream without one", async () => {
    const pucClass = await createClassLevel(school.id, {
      name: "X", ladder_order: 10, stage: "secondary",
    });
    const firstPuc = await pool.query(
      `INSERT INTO class_levels (school_id, name, ladder_order, stage, requires_explicit_optin, requires_stream)
       VALUES ($1, '1st PU', 11, 'puc', true, true) RETURNING *`,
      [school.id],
    );
    const pucSection = await createSection(school.id, fromYear.id, pucClass.id, "A");
    const student = await createStudent(school.id);
    await createEnrollment(school.id, student.id, fromYear.id, pucClass.id, pucSection.id);

    const result = await preview({ fromYearId: fromYear.id, toYearId: toYear.id });
    expect(result.moves).toHaveLength(1);
    expect(result.moves[0].needsOptin).toBe(true);
    expect(isActionable(result.moves[0])).toBe(false); // needs an explicit decision first
    void firstPuc;
  });

  it("carries the same stream forward automatically (1st PU -> 2nd PU)", async () => {
    const stream = await pool.query(
      `INSERT INTO streams (school_id, name) VALUES ($1, 'Science') RETURNING *`, [school.id],
    );
    const firstPuc = await pool.query(
      `INSERT INTO class_levels (school_id, name, ladder_order, stage, requires_stream)
       VALUES ($1, '1st PU', 20, 'puc', true) RETURNING *`,
      [school.id],
    );
    await pool.query(
      `INSERT INTO class_levels (school_id, name, ladder_order, stage, requires_stream)
       VALUES ($1, '2nd PU', 21, 'puc', true)`,
      [school.id],
    );
    const puSection = await createSection(school.id, fromYear.id, firstPuc.rows[0].id, "A");
    const student = await createStudent(school.id);
    await pool.query(
      `INSERT INTO enrollments (school_id, student_id, academic_year_id, class_level_id,
                                 section_id, stream_id, admission_type)
       VALUES ($1, $2, $3, $4, $5, $6, 'new')`,
      [school.id, student.id, fromYear.id, firstPuc.rows[0].id, puSection.id, stream.rows[0].id],
    );

    const result = await preview({ fromYearId: fromYear.id, toYearId: toYear.id });
    expect(result.moves).toHaveLength(1);
    expect(result.moves[0].needsStream).toBe(false);
    expect(result.moves[0].streamId).toBe(stream.rows[0].id);
  });

  it("blocks on outstanding dues when the school policy requires it", async () => {
    const { enrollment } = await studentInVIII();
    await generateCharges(enrollment.id); // owes 40,000, unpaid

    const result = await preview({ fromYearId: fromYear.id, toYearId: toYear.id, blockOnDues: true });
    expect(result.moves).toHaveLength(0);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].blockedReason).toContain("Outstanding dues");
  });

  it("rejects a target year that doesn't follow the source year", async () => {
    await expect(preview({ fromYearId: toYear.id, toYearId: fromYear.id }))
      .rejects.toThrow(PromotionError);
  });
});

describe("assignSections", () => {
  it("keeps the same section name when it exists and has room", async () => {
    const { enrollment } = await studentInVIII();
    const result = await preview({ fromYearId: fromYear.id, toYearId: toYear.id });
    const moves = await assignSections(result.moves, { toYearId: toYear.id });
    expect(moves[0].toSectionId).toBe(sectionIX_A.id);
    void enrollment;
  });

  it("balances into the least-full section when 'keep' isn't available", async () => {
    await createSection(school.id, toYear.id, classIX.id, "B"); // IX-B, empty
    // Fill IX-A with an existing enrollment so it's no longer the emptiest.
    const filler = await createStudent(school.id);
    await createEnrollment(school.id, filler.id, toYear.id, classIX.id, sectionIX_A.id);

    const { enrollment } = await studentInVIII();
    void enrollment;
    const result = await preview({ fromYearId: fromYear.id, toYearId: toYear.id });
    const moves = await assignSections(result.moves, { toYearId: toYear.id, strategy: "balance" });

    const sectionB = await pool.query(`SELECT id FROM sections WHERE academic_year_id = $1 AND name = 'B'`,
      [toYear.id]);
    expect(moves[0].toSectionId).toBe(sectionB.rows[0].id); // less full than A
  });

  it("throws when no sections exist for the target class", async () => {
    // VIII has a section in fromYear but deliberately none in toYear (the
    // fixtures only set up sectionIX_A there) — so VII -> VIII should hit
    // exactly this guard once assignSections tries to place the student.
    const otherClass = await createClassLevel(school.id, { name: "VII", ladder_order: 7 });
    const otherSection = await createSection(school.id, fromYear.id, otherClass.id, "A");
    const student = await createStudent(school.id);
    await createEnrollment(school.id, student.id, fromYear.id, otherClass.id, otherSection.id);

    const result = await preview({ fromYearId: fromYear.id, toYearId: toYear.id });
    const viiMove = result.moves.find((m) => m.fromClassName === "VII");
    expect(viiMove).toBeDefined();
    await expect(assignSections([viiMove!], { toYearId: toYear.id }))
      .rejects.toThrow(PromotionError);
  });
});

describe("commit", () => {
  async function previewAndAssign() {
    const result = await preview({ fromYearId: fromYear.id, toYearId: toYear.id });
    const moves = await assignSections(result.moves, { toYearId: toYear.id });
    return { result, moves };
  }

  it("creates a new carry-over enrollment and marks the old one promoted", async () => {
    const { enrollment: oldEnrollment } = await studentInVIII();
    const { moves } = await previewAndAssign();

    const batch = await commit({ fromYearId: fromYear.id, toYearId: toYear.id, moves }) as any;
    expect(batch.status).toBe("committed");

    const oldRow = await pool.query(`SELECT outcome, is_active FROM enrollments WHERE id = $1`,
      [oldEnrollment.id]);
    expect(oldRow.rows[0].outcome).toBe("promoted");
    expect(oldRow.rows[0].is_active).toBe(false);

    const newRow = await pool.query(
      `SELECT admission_type, class_level_id FROM enrollments
       WHERE promotion_batch_id = $1`, [batch.id],
    );
    expect(newRow.rows[0].admission_type).toBe("carry_over");
    expect(newRow.rows[0].class_level_id).toBe(classIX.id);
  });

  it("carries forward arrears before posting the new year's charges", async () => {
    const { enrollment: oldEnrollment } = await studentInVIII();
    await generateCharges(oldEnrollment.id); // owes 40,000, unpaid
    const { moves } = await previewAndAssign();

    const batch = await commit({ fromYearId: fromYear.id, toYearId: toYear.id, moves }) as any;

    const newEnrollment = await pool.query(
      `SELECT id FROM enrollments WHERE promotion_batch_id = $1`, [batch.id],
    );
    const arrear = await pool.query(
      `SELECT amount FROM charges WHERE enrollment_id = $1 AND is_arrear = true`,
      [newEnrollment.rows[0].id],
    );
    expect(arrear.rows[0].amount).toBe(4000000);

    const currentTuition = await pool.query(
      `SELECT amount FROM charges WHERE enrollment_id = $1 AND is_arrear = false`,
      [newEnrollment.rows[0].id],
    );
    expect(currentTuition.rows[0].amount).toBe(4200000); // this year's tuition, not last year's
  });

  it("the ledger separately reports the arrears portion of the balance, and it shrinks first when paid", async () => {
    const { enrollment: oldEnrollment } = await studentInVIII();
    await generateCharges(oldEnrollment.id); // owes 40,000, unpaid
    const { moves } = await previewAndAssign();
    const batch = await commit({ fromYearId: fromYear.id, toYearId: toYear.id, moves }) as any;
    const newEnrollment = await pool.query(
      `SELECT id FROM enrollments WHERE promotion_batch_id = $1`, [batch.id],
    );
    const enrollmentId = newEnrollment.rows[0].id;

    const before = await getEnrollmentLedger(enrollmentId);
    expect(before.charged).toBe(4000000 + 4200000); // arrears + this year's tuition
    expect(before.arrearsCharged).toBe(4000000);
    expect(before.arrearsBalance).toBe(4000000); // nothing paid toward it yet
    expect(before.balance).toBe(8200000);

    // A partial payment, smaller than the arrears alone — should go
    // entirely toward the arrears first, per the allocation ordering
    // (is_arrear DESC), leaving the arrears balance still owing but
    // smaller, and this year's own tuition completely untouched.
    await recordPayment({ enrollmentId, amount: 1500000, mode: "cash" });
    const after = await getEnrollmentLedger(enrollmentId);
    expect(after.arrearsCharged).toBe(4000000); // the original charge amount never changes
    expect(after.arrearsBalance).toBe(4000000 - 1500000);
    expect(after.balance).toBe(8200000 - 1500000);
  });

  it("marks a terminal-class student alumni instead of creating a new enrollment", async () => {
    const terminalClass = await createClassLevel(school.id, {
      name: "2nd PU", ladder_order: 30, is_terminal: true,
    });
    const terminalSection = await createSection(school.id, fromYear.id, terminalClass.id, "A");
    const student = await createStudent(school.id);
    const enrollment = await createEnrollment(
      school.id, student.id, fromYear.id, terminalClass.id, terminalSection.id,
    );

    const result = await preview({ fromYearId: fromYear.id, toYearId: toYear.id });
    // Nothing actionable in `moves` this time — need at least one promotable
    // student too, since commit() refuses an empty actionable set.
    const { enrollment: otherEnrollment } = await studentInVIII();
    void otherEnrollment;
    const freshResult = await preview({ fromYearId: fromYear.id, toYearId: toYear.id });
    const moves = await assignSections(freshResult.moves, { toYearId: toYear.id });

    await commit({
      fromYearId: fromYear.id, toYearId: toYear.id, moves: [...moves, ...freshResult.graduating],
    });

    const studentRow = await pool.query(`SELECT status FROM students WHERE id = $1`, [student.id]);
    expect(studentRow.rows[0].status).toBe("alumni");
    const enrollmentRow = await pool.query(`SELECT outcome, is_active FROM enrollments WHERE id = $1`,
      [enrollment.id]);
    expect(enrollmentRow.rows[0].outcome).toBe("passed_out");
    expect(enrollmentRow.rows[0].is_active).toBe(false);
    void result;
  });

  it("refuses to commit with no actionable moves", async () => {
    await expect(commit({ fromYearId: fromYear.id, toYearId: toYear.id, moves: [] }))
      .rejects.toThrow(PromotionError);
  });

  it("refuses to commit a move with no section assigned", async () => {
    const { enrollment } = await studentInVIII();
    void enrollment;
    const result = await preview({ fromYearId: fromYear.id, toYearId: toYear.id });
    // Deliberately skip assignSections.
    await expect(commit({ fromYearId: fromYear.id, toYearId: toYear.id, moves: result.moves }))
      .rejects.toThrow(PromotionError);
  });

  it("refuses to commit into a closed target year", async () => {
    await pool.query(`UPDATE academic_years SET status = 'closed' WHERE id = $1`, [toYear.id]);
    const { moves } = await previewAndAssign();
    await expect(commit({ fromYearId: fromYear.id, toYearId: toYear.id, moves }))
      .rejects.toThrow(PromotionError);
  });
});

describe("reverseBatch", () => {
  it("undoes a committed batch while the target year is still planning", async () => {
    await pool.query(`UPDATE academic_years SET status = 'planning' WHERE id = $1`, [toYear.id]);
    const { enrollment: oldEnrollment } = await studentInVIII();
    const result = await preview({ fromYearId: fromYear.id, toYearId: toYear.id });
    const moves = await assignSections(result.moves, { toYearId: toYear.id });
    const batch = await commit({ fromYearId: fromYear.id, toYearId: toYear.id, moves }) as any;

    await reverseBatch(batch.id);

    const newEnrollments = await pool.query(`SELECT id FROM enrollments WHERE promotion_batch_id = $1`,
      [batch.id]);
    expect(newEnrollments.rows).toHaveLength(0); // deleted

    const oldRow = await pool.query(`SELECT outcome, is_active FROM enrollments WHERE id = $1`,
      [oldEnrollment.id]);
    expect(oldRow.rows[0].outcome).toBe("pending");
    expect(oldRow.rows[0].is_active).toBe(true); // restored

    const batchRow = await pool.query(`SELECT status FROM promotion_batches WHERE id = $1`, [batch.id]);
    expect(batchRow.rows[0].status).toBe("reversed");
  });

  it("refuses to reverse once a payment has been recorded against the batch", async () => {
    await studentInVIII();
    const result = await preview({ fromYearId: fromYear.id, toYearId: toYear.id });
    const moves = await assignSections(result.moves, { toYearId: toYear.id });
    const batch = await commit({ fromYearId: fromYear.id, toYearId: toYear.id, moves }) as any;

    const newEnrollment = await pool.query(`SELECT id FROM enrollments WHERE promotion_batch_id = $1`,
      [batch.id]);
    await recordPayment({ enrollmentId: newEnrollment.rows[0].id, amount: 100000, mode: "cash" });

    await expect(reverseBatch(batch.id)).rejects.toThrow(PromotionError);
  });

  it("refuses to reverse once the target year is no longer planning", async () => {
    await studentInVIII();
    const result = await preview({ fromYearId: fromYear.id, toYearId: toYear.id });
    const moves = await assignSections(result.moves, { toYearId: toYear.id });
    const batch = await commit({ fromYearId: fromYear.id, toYearId: toYear.id, moves }) as any;

    await pool.query(`UPDATE academic_years SET status = 'active' WHERE id = $1`, [toYear.id]);
    await expect(reverseBatch(batch.id)).rejects.toThrow(PromotionError);
  });
});

describe("previewSummary", () => {
  it("summarises the preview correctly", async () => {
    await studentInVIII();
    const result = await preview({ fromYearId: fromYear.id, toYearId: toYear.id });
    const summary = previewSummary(result);
    expect(summary.promotable).toBe(1);
    expect(summary.needsDecision).toBe(0);
    expect(summary.graduating).toBe(0);
    expect(summary.blocked).toBe(0);
  });
});
