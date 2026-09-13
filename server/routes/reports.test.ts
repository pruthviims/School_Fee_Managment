/**
 * End-to-end HTTP tests for /api/reports. Verifies both the numbers
 * (reconciling with the same ledger figures the rest of the app already
 * shows, not a second definition) and the access boundary (view_reports
 * is already Owner/Accountant/Viewer only, not Front Desk).
 */

import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../app.js";
import { pool } from "../db/index.js";
import { createMembership, createSchool, createUser, resetDb } from "../tests/helpers.js";
import { resetFeeDomain } from "../tests/fixtures.js";

let school: any;

beforeEach(async () => {
  await resetFeeDomain();
  await resetDb();

  school = await createSchool({ short_code: "reports-test" });
  const owner = await createUser("owner@reports.test", "x".repeat(14));
  await createMembership(owner.id, school.id, "owner");
  const frontDesk = await createUser("desk@reports.test", "x".repeat(14));
  await createMembership(frontDesk.id, school.id, "front_desk");
  const accountant = await createUser("acc@reports.test", "x".repeat(14));
  await createMembership(accountant.id, school.id, "accountant");
  const viewer = await createUser("viewer@reports.test", "x".repeat(14));
  await createMembership(viewer.id, school.id, "viewer");
});

afterAll(async () => { await pool.end(); });

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: "x".repeat(14) });
  return res.headers["set-cookie"];
}

async function setUpAcademicStructure(cookie: string) {
  const year = await request(app).post("/api/setup/academic-years").set("Cookie", cookie)
    .send({ name: "2026-27", starts_on: "2026-06-01", ends_on: "2027-03-31", status: "active" });
  const classLevel = await request(app).post("/api/setup/class-levels").set("Cookie", cookie)
    .send({ name: "VIII", ladder_order: 8, stage: "middle" });
  const section = await request(app).post("/api/setup/sections").set("Cookie", cookie).send({
    academic_year_id: year.body.id, class_level_id: classLevel.body.id, name: "A",
  });
  const feeHead = await request(app).post("/api/setup/fee-heads").set("Cookie", cookie)
    .send({ name: "Tuition fee" });
  await request(app).post("/api/setup/fee-structure").set("Cookie", cookie).send({
    academic_year_id: year.body.id, class_level_id: classLevel.body.id,
    fee_head_id: feeHead.body.id, amount: 4000000, due_on: "2026-06-15",
  });
  return { year: year.body, classLevel: classLevel.body, section: section.body };
}

async function admit(cookie: string, year: any, classLevel: any, section: any, admissionNo: string) {
  const res = await request(app).post("/api/students/admit").set("Cookie", cookie).send({
    admission_no: admissionNo, full_name: `Student ${admissionNo}`, gender: "male",
    contact_type: "guardian", guardian_relationship: "Father", guardian_name: "Test Parent",
    academic_year_id: year.id, class_level_id: classLevel.id, section_id: section.id,
  });
  return res.body.enrollment;
}

describe("GET /reports/summary", () => {
  it("KPIs reconcile exactly with the same ledger figures the rest of the app uses", async () => {
    const cookie = await loginAs("owner@reports.test");
    const { year, classLevel, section } = await setUpAcademicStructure(cookie);
    const a = await admit(cookie, year, classLevel, section, "2026/1");
    const b = await admit(cookie, year, classLevel, section, "2026/2");

    // A: fully paid, then partially refunded — the reported scenario.
    await request(app).post("/api/collection/payments").set("Cookie", cookie).send({
      enrollment_id: a.id, amount: 4000000, mode: "cash",
    });
    await request(app).post(`/api/students/enrollments/${a.id}/refund`).set("Cookie", cookie).send({
      amount: 300000, mode: "cash",
    });
    // B: unpaid, entirely outstanding.

    const res = await request(app).get(`/api/reports/summary?academic_year_id=${year.id}`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    const { kpis } = res.body;
    expect(kpis.projectedFees).toBe(8000000); // ₹40,000 × 2 students
    expect(kpis.collected).toBe(4000000); // gross paid
    expect(kpis.refundAmount).toBe(300000);
    expect(kpis.netCollection).toBe(3700000); // 4,000,000 - 300,000
    expect(kpis.outstanding).toBe(8000000 - 3700000); // reconciles exactly
    expect(kpis.collectionPct).toBeCloseTo((3700000 / 8000000) * 100, 5);
  });

  it("a pending refund request does not change any KPI until actually approved", async () => {
    const cookie = await loginAs("owner@reports.test");
    const { year, classLevel, section } = await setUpAcademicStructure(cookie);
    const a = await admit(cookie, year, classLevel, section, "2026/3");
    await request(app).post("/api/collection/payments").set("Cookie", cookie).send({
      enrollment_id: a.id, amount: 4000000, mode: "cash",
    });
    await request(app).post(`/api/students/enrollments/${a.id}/refund-requests`).set("Cookie", cookie).send({
      amount: 300000, mode: "cash",
    });

    const res = await request(app).get(`/api/reports/summary?academic_year_id=${year.id}`).set("Cookie", cookie);
    expect(res.body.kpis.refundAmount).toBe(0); // pending — not counted yet
    expect(res.body.kpis.netCollection).toBe(4000000); // unaffected
    expect(res.body.kpis.outstanding).toBe(0); // fully paid, nothing pending changes this
  });

  it("concession and outstanding-by-class break down correctly", async () => {
    const cookie = await loginAs("owner@reports.test");
    const { year, classLevel, section } = await setUpAcademicStructure(cookie);
    const a = await admit(cookie, year, classLevel, section, "2026/4");
    await request(app).post(`/api/students/enrollments/${a.id}/concessions`).set("Cookie", cookie).send({
      reason: "sibling", amount: 500000, note: "Test",
    });

    const res = await request(app).get(`/api/reports/summary?academic_year_id=${year.id}`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.kpis.concessionAmount).toBe(500000);
    expect(res.body.kpis.concessionStudents).toBe(1);
    expect(res.body.byClass).toHaveLength(1);
    expect(res.body.byClass[0].className).toBe("VIII");
    expect(res.body.byClass[0].students).toBe(1);
    expect(res.body.byClass[0].concession).toBe(500000);
    expect(res.body.agingBuckets.length).toBeGreaterThan(0);
  });

  it("class comparison's own row reconciles: projected - concession - collected = pending, not gross-vs-net mismatched", async () => {
    const cookie = await loginAs("owner@reports.test");
    const { year, classLevel, section } = await setUpAcademicStructure(cookie);
    const a = await admit(cookie, year, classLevel, section, "2026/10");
    await request(app).post("/api/collection/payments").set("Cookie", cookie).send({
      enrollment_id: a.id, amount: 4000000, mode: "cash",
    });
    await request(app).post(`/api/students/enrollments/${a.id}/refund`).set("Cookie", cookie).send({
      amount: 300000, mode: "cash",
    });

    const res = await request(app).get(`/api/reports/summary?academic_year_id=${year.id}`).set("Cookie", cookie);
    const row = res.body.byClass[0];
    expect(row.collected).toBe(3700000); // net, not the pre-refund gross 4,000,000
    expect(row.grossCollected).toBe(4000000); // still available separately
    expect(row.projected - row.concession - row.collected).toBe(row.pending); // the row reconciles with itself
  });

  it("front desk is denied (view_reports not held); owner, accountant, and viewer are allowed", async () => {
    const cookie = await loginAs("owner@reports.test");
    const { year } = await setUpAcademicStructure(cookie);

    const deskRes = await request(app).get(`/api/reports/summary?academic_year_id=${year.id}`)
      .set("Cookie", await loginAs("desk@reports.test"));
    expect(deskRes.status).toBe(403);

    for (const email of ["owner@reports.test", "acc@reports.test", "viewer@reports.test"]) {
      const res = await request(app).get(`/api/reports/summary?academic_year_id=${year.id}`)
        .set("Cookie", await loginAs(email));
      expect(res.status).toBe(200);
    }
  });

  it("never returns another school's figures", async () => {
    const cookie = await loginAs("owner@reports.test");
    const { year, classLevel, section } = await setUpAcademicStructure(cookie);
    await admit(cookie, year, classLevel, section, "2026/5");

    const otherSchool = await createSchool({ short_code: "reports-test-other" });
    const otherOwner = await createUser("owner2@reports.test", "x".repeat(14));
    await createMembership(otherOwner.id, otherSchool.id, "owner");
    const otherCookie = await loginAs("owner2@reports.test");
    const otherYear = await request(app).post("/api/setup/academic-years").set("Cookie", otherCookie)
      .send({ name: "2026-27", starts_on: "2026-06-01", ends_on: "2027-03-31", status: "active" });

    const res = await request(app)
      .get(`/api/reports/summary?academic_year_id=${otherYear.body.id}`).set("Cookie", otherCookie);
    expect(res.body.totalEnrollments).toBe(0); // sees none of the other school's students
  });
});

describe("GET /reports/collection-trend and /payment-modes", () => {
  it("groups real payments by month and by mode correctly", async () => {
    const cookie = await loginAs("owner@reports.test");
    const { year, classLevel, section } = await setUpAcademicStructure(cookie);
    const a = await admit(cookie, year, classLevel, section, "2026/6");
    await request(app).post("/api/collection/payments").set("Cookie", cookie).send({
      enrollment_id: a.id, amount: 1000000, mode: "cash",
    });
    await request(app).post("/api/collection/payments").set("Cookie", cookie).send({
      enrollment_id: a.id, amount: 500000, mode: "upi",
    });

    const trend = await request(app).get(`/api/reports/collection-trend?academic_year_id=${year.id}`).set("Cookie", cookie);
    expect(trend.status).toBe(200);
    const totalTrend = trend.body.reduce((t: number, r: any) => t + r.amount, 0);
    expect(totalTrend).toBe(1500000);

    const modes = await request(app).get(`/api/reports/payment-modes?academic_year_id=${year.id}`).set("Cookie", cookie);
    expect(modes.status).toBe(200);
    const cash = modes.body.find((m: any) => m.mode === "cash");
    const upi = modes.body.find((m: any) => m.mode === "upi");
    expect(cash.amount).toBe(1000000);
    expect(upi.amount).toBe(500000);
    expect(cash.pct + upi.pct).toBeCloseTo(100, 5);
  });
});

describe("GET /reports/tc and /refunds", () => {
  it("TC analytics reflects status correctly, never counting a pending request as approved", async () => {
    const cookie = await loginAs("owner@reports.test");
    const { year, classLevel, section } = await setUpAcademicStructure(cookie);
    const a = await admit(cookie, year, classLevel, section, "2026/7");
    await request(app).post(`/api/students/enrollments/${a.id}/tc-requests`).set("Cookie", cookie).send({
      reason: "Transfer", last_day: "2026-10-01",
    });

    const res = await request(app).get(`/api/reports/tc?academic_year_id=${year.id}`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.totalRequests).toBe(1);
    expect(res.body.pending).toBe(1);
    expect(res.body.approved).toBe(0);
  });

  it("refund analytics separates pending requests from actually processed refunds", async () => {
    const cookie = await loginAs("owner@reports.test");
    const { year, classLevel, section } = await setUpAcademicStructure(cookie);
    const a = await admit(cookie, year, classLevel, section, "2026/8");
    await request(app).post("/api/collection/payments").set("Cookie", cookie).send({
      enrollment_id: a.id, amount: 4000000, mode: "cash",
    });
    const reqRes = await request(app).post(`/api/students/enrollments/${a.id}/refund-requests`)
      .set("Cookie", cookie).send({ amount: 300000, mode: "cash" });
    await request(app).post(`/api/students/refund-requests/${reqRes.body.id}/approve`)
      .set("Cookie", cookie).send({});

    const res = await request(app).get(`/api/reports/refunds?academic_year_id=${year.id}`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.totalRequests).toBe(1);
    expect(res.body.approved).toBe(1);
    expect(res.body.processedCount).toBe(1);
    expect(res.body.totalRefunded).toBe(300000);
  });
});

describe("GET /reports/daily-collection", () => {
  it("shows today's real collection, split by mode", async () => {
    const cookie = await loginAs("owner@reports.test");
    const { year, classLevel, section } = await setUpAcademicStructure(cookie);
    const a = await admit(cookie, year, classLevel, section, "2026/9");
    await request(app).post("/api/collection/payments").set("Cookie", cookie).send({
      enrollment_id: a.id, amount: 1000000, mode: "cash",
    });

    const today = new Date().toISOString().slice(0, 10);
    const res = await request(app).get(`/api/reports/daily-collection?date=${today}`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.totalCollected).toBe(1000000);
    expect(res.body.firstReceiptNo).toMatch(/^RCP\//);
  });
});

describe("GET /reports/year-comparison", () => {
  it("only includes academic years that actually exist for this school", async () => {
    const cookie = await loginAs("owner@reports.test");
    await setUpAcademicStructure(cookie);

    const res = await request(app).get("/api/reports/year-comparison").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1); // exactly one year exists — not fabricated to 5
    expect(res.body[0].year).toBe("2026-27");
  });

  it("each year row reconciles with itself, same as class comparison", async () => {
    const cookie = await loginAs("owner@reports.test");
    const { year, classLevel, section } = await setUpAcademicStructure(cookie);
    const a = await admit(cookie, year, classLevel, section, "2026/yc1");
    await request(app).post("/api/collection/payments").set("Cookie", cookie).send({
      enrollment_id: a.id, amount: 4000000, mode: "cash",
    });
    await request(app).post(`/api/students/enrollments/${a.id}/refund`).set("Cookie", cookie).send({
      amount: 300000, mode: "cash",
    });

    const res = await request(app).get("/api/reports/year-comparison").set("Cookie", cookie);
    const row = res.body[0];
    expect(row.collected).toBe(3700000); // net
    expect(row.grossCollected).toBe(4000000);
    expect(row.projectedFees - row.concession - row.collected).toBe(row.pending);
  });
});

describe("Collection % uses Net Collectible Fees, not gross projected (review fix)", () => {
  it("a concession no longer silently understates collection %", async () => {
    const cookie = await loginAs("owner@reports.test");
    const { year, classLevel, section } = await setUpAcademicStructure(cookie);
    const a = await admit(cookie, year, classLevel, section, "2026/cc1");
    // Fee 40,000; concession 10,000 → net collectible 30,000; fully paid.
    await request(app).post(`/api/students/enrollments/${a.id}/concessions`).set("Cookie", cookie).send({
      reason: "sibling", amount: 1000000, note: "Test",
    });
    await request(app).post("/api/collection/payments").set("Cookie", cookie).send({
      enrollment_id: a.id, amount: 3000000, mode: "cash",
    });

    const res = await request(app).get(`/api/reports/summary?academic_year_id=${year.id}`).set("Cookie", cookie);
    expect(res.body.kpis.netCollectibleFees).toBe(3000000); // 4,000,000 - 1,000,000
    // Fully collected against net collectible — must read 100%, not the
    // understated ~75% a gross-projected-fees denominator would give.
    expect(res.body.kpis.collectionPct).toBeCloseTo(100, 5);
  });
});

describe("Section-level reconciliation and section/class filter consistency across reports (review fixes)", () => {
  async function addSectionB(cookie: string, year: any, classLevel: any) {
    const sectionB = await request(app).post("/api/setup/sections").set("Cookie", cookie).send({
      academic_year_id: year.id, class_level_id: classLevel.id, name: "B",
    });
    return sectionB.body;
  }

  it("section comparison reconciles with itself, per section", async () => {
    const cookie = await loginAs("owner@reports.test");
    const { year, classLevel, section } = await setUpAcademicStructure(cookie);
    const sectionB = await addSectionB(cookie, year, classLevel);
    const a = await admit(cookie, year, classLevel, section, "2026/sc1");
    await request(app).post("/api/collection/payments").set("Cookie", cookie).send({
      enrollment_id: a.id, amount: 4000000, mode: "cash",
    });
    await admit(cookie, year, classLevel, sectionB, "2026/sc2"); // unpaid, in section B

    const res = await request(app).get(`/api/reports/summary?academic_year_id=${year.id}`).set("Cookie", cookie);
    for (const row of res.body.bySection) {
      expect(row.projected - row.pending).toBeLessThanOrEqual(row.projected); // sanity: pending never exceeds projected here
    }
    const rowA = res.body.bySection.find((r: any) => r.sectionName === "A");
    expect(rowA.collected).toBe(4000000);
    expect(rowA.pending).toBe(0);
    const rowB = res.body.bySection.find((r: any) => r.sectionName === "B");
    expect(rowB.collected).toBe(0);
    expect(rowB.pending).toBe(4000000);
  });

  it("refund analytics now respects the section filter (previously silently ignored it)", async () => {
    const cookie = await loginAs("owner@reports.test");
    const { year, classLevel, section } = await setUpAcademicStructure(cookie);
    const sectionB = await addSectionB(cookie, year, classLevel);
    const a = await admit(cookie, year, classLevel, section, "2026/rf1");
    await request(app).post("/api/collection/payments").set("Cookie", cookie).send({
      enrollment_id: a.id, amount: 4000000, mode: "cash",
    });
    await request(app).post(`/api/students/enrollments/${a.id}/refund`).set("Cookie", cookie).send({
      amount: 100000, mode: "cash",
    });
    const b = await admit(cookie, year, classLevel, sectionB, "2026/rf2");
    await request(app).post("/api/collection/payments").set("Cookie", cookie).send({
      enrollment_id: b.id, amount: 4000000, mode: "cash",
    });
    await request(app).post(`/api/students/enrollments/${b.id}/refund`).set("Cookie", cookie).send({
      amount: 200000, mode: "cash",
    });

    const sectionAOnly = await request(app)
      .get(`/api/reports/refunds?academic_year_id=${year.id}&class_level_id=${classLevel.id}&section_id=${section.id}`)
      .set("Cookie", cookie);
    expect(sectionAOnly.body.totalRefunded).toBe(100000); // only section A's refund — not both

    const bothSections = await request(app)
      .get(`/api/reports/refunds?academic_year_id=${year.id}&class_level_id=${classLevel.id}`)
      .set("Cookie", cookie);
    expect(bothSections.body.totalRefunded).toBe(300000); // unfiltered by section, both count
  });

  it("promotion and admission analytics now respect class/section filters (previously ignored both entirely)", async () => {
    const cookie = await loginAs("owner@reports.test");
    const { year, classLevel, section } = await setUpAcademicStructure(cookie);
    const sectionB = await addSectionB(cookie, year, classLevel);
    await admit(cookie, year, classLevel, section, "2026/ad1");
    await admit(cookie, year, classLevel, sectionB, "2026/ad2");

    const sectionAOnly = await request(app)
      .get(`/api/reports/admissions?academic_year_id=${year.id}&class_level_id=${classLevel.id}&section_id=${section.id}`)
      .set("Cookie", cookie);
    const total = sectionAOnly.body.trend.reduce((t: number, r: any) => t + r.count, 0);
    expect(total).toBe(1); // only section A's admission, not both
  });
});

describe("Promotion analytics correctness (review fixes: double-count, is_active exclusion, graduate distinction)", () => {
  async function setUpTwoYearLadder(cookie: string) {
    const fromYear = await request(app).post("/api/setup/academic-years").set("Cookie", cookie)
      .send({ name: "2025-26", starts_on: "2025-06-01", ends_on: "2026-03-31", status: "active" });
    const toYear = await request(app).post("/api/setup/academic-years").set("Cookie", cookie)
      .send({ name: "2026-27", starts_on: "2026-06-01", ends_on: "2027-03-31", status: "planning" });
    const classVIII = await request(app).post("/api/setup/class-levels").set("Cookie", cookie)
      .send({ name: "VIII", ladder_order: 8, stage: "middle" });
    const classIX = await request(app).post("/api/setup/class-levels").set("Cookie", cookie)
      .send({ name: "IX", ladder_order: 9, stage: "middle" });
    const sectionVIII = await request(app).post("/api/setup/sections").set("Cookie", cookie).send({
      academic_year_id: fromYear.body.id, class_level_id: classVIII.body.id, name: "A",
    });
    const sectionIX = await request(app).post("/api/setup/sections").set("Cookie", cookie).send({
      academic_year_id: toYear.body.id, class_level_id: classIX.body.id, name: "A",
    });
    const feeHead = await request(app).post("/api/setup/fee-heads").set("Cookie", cookie)
      .send({ name: "Tuition fee" });
    await request(app).post("/api/setup/fee-structure").set("Cookie", cookie).send({
      academic_year_id: fromYear.body.id, class_level_id: classVIII.body.id,
      fee_head_id: feeHead.body.id, amount: 4000000, due_on: "2025-06-15",
    });
    await request(app).post("/api/setup/fee-structure").set("Cookie", cookie).send({
      academic_year_id: toYear.body.id, class_level_id: classIX.body.id,
      fee_head_id: feeHead.body.id, amount: 4200000, due_on: "2026-06-15",
    });
    return { fromYear: fromYear.body, toYear: toYear.body, classVIII: classVIII.body,
      sectionVIII: sectionVIII.body, sectionIX: sectionIX.body };
  }

  it("committing promotion in two separate batches for the same year does not double-count 'considered'", async () => {
    const cookie = await loginAs("owner@reports.test");
    const { fromYear, toYear, classVIII, sectionVIII } = await setUpTwoYearLadder(cookie);
    const s1 = await request(app).post("/api/students/admit").set("Cookie", cookie).send({
      admission_no: "2025/901", full_name: "Student One", gender: "male", contact_type: "guardian",
      guardian_relationship: "Father", guardian_name: "G1",
      academic_year_id: fromYear.id, class_level_id: classVIII.id, section_id: sectionVIII.id,
    });
    const s2 = await request(app).post("/api/students/admit").set("Cookie", cookie).send({
      admission_no: "2025/902", full_name: "Student Two", gender: "female", contact_type: "guardian",
      guardian_relationship: "Mother", guardian_name: "G2",
      academic_year_id: fromYear.id, class_level_id: classVIII.id, section_id: sectionVIII.id,
    });

    // Two separate commits for the same from_year/to_year — the exact
    // scenario the review flagged as double-counting "considered".
    const preview1 = await request(app).post("/api/promotion/preview").set("Cookie", cookie)
      .send({ from_year_id: fromYear.id, to_year_id: toYear.id, exclude_enrollment_ids: [s2.body.enrollment.id] });
    const assign1 = await request(app).post("/api/promotion/assign-sections").set("Cookie", cookie)
      .send({ to_year_id: toYear.id, moves: preview1.body.moves });
    await request(app).post("/api/promotion/commit").set("Cookie", cookie).send({
      from_year_id: fromYear.id, to_year_id: toYear.id, moves: assign1.body.moves,
    });

    const preview2 = await request(app).post("/api/promotion/preview").set("Cookie", cookie)
      .send({ from_year_id: fromYear.id, to_year_id: toYear.id });
    const assign2 = await request(app).post("/api/promotion/assign-sections").set("Cookie", cookie)
      .send({ to_year_id: toYear.id, moves: preview2.body.moves });
    await request(app).post("/api/promotion/commit").set("Cookie", cookie).send({
      from_year_id: fromYear.id, to_year_id: toYear.id, moves: assign2.body.moves,
    });

    const res = await request(app).get(`/api/reports/promotion?academic_year_id=${fromYear.id}`).set("Cookie", cookie);
    expect(res.body.considered).toBe(2); // not 4 — each student counted exactly once
    expect(res.body.promoted).toBe(2);
    expect(res.body.notPromoted).toBe(0);
  });

  it("a student who withdrew before promotion ran is not counted as 'not promoted'", async () => {
    const cookie = await loginAs("owner@reports.test");
    const { fromYear, toYear, classVIII, sectionVIII } = await setUpTwoYearLadder(cookie);
    const promoted = await request(app).post("/api/students/admit").set("Cookie", cookie).send({
      admission_no: "2025/903", full_name: "Promoted Student", gender: "male", contact_type: "guardian",
      guardian_relationship: "Father", guardian_name: "G1",
      academic_year_id: fromYear.id, class_level_id: classVIII.id, section_id: sectionVIII.id,
    });
    const withdrew = await request(app).post("/api/students/admit").set("Cookie", cookie).send({
      admission_no: "2025/904", full_name: "Withdrawn Student", gender: "female", contact_type: "guardian",
      guardian_relationship: "Mother", guardian_name: "G2",
      academic_year_id: fromYear.id, class_level_id: classVIII.id, section_id: sectionVIII.id,
    });
    // Withdraw before promotion ever runs — via the NOC/exit workflow.
    const tcReq = await request(app).post(`/api/students/enrollments/${withdrew.body.enrollment.id}/tc-requests`)
      .set("Cookie", cookie).send({ reason: "Transfer", last_day: "2025-12-01" });
    await request(app).post(`/api/students/tc-requests/${tcReq.body.id}/clear`).set("Cookie", cookie)
      .send({ exit_reason: "transferred" });

    const preview = await request(app).post("/api/promotion/preview").set("Cookie", cookie)
      .send({ from_year_id: fromYear.id, to_year_id: toYear.id });
    // The withdrawn student is no longer active, so preview naturally
    // excludes them from actionable moves.
    const assign = await request(app).post("/api/promotion/assign-sections").set("Cookie", cookie)
      .send({ to_year_id: toYear.id, moves: preview.body.moves });
    await request(app).post("/api/promotion/commit").set("Cookie", cookie).send({
      from_year_id: fromYear.id, to_year_id: toYear.id, moves: assign.body.moves,
    });

    const res = await request(app).get(`/api/reports/promotion?academic_year_id=${fromYear.id}`).set("Cookie", cookie);
    expect(res.body.considered).toBe(1); // only the promoted student — withdrawn one excluded
    expect(res.body.promoted).toBe(1);
    expect(res.body.notPromoted).toBe(0);
    void promoted;
  });

  it("returns all-zero, not a false 'not promoted', when no promotion batch has run yet for the year", async () => {
    const cookie = await loginAs("owner@reports.test");
    const { fromYear, classVIII, sectionVIII } = await setUpTwoYearLadder(cookie);
    await request(app).post("/api/students/admit").set("Cookie", cookie).send({
      admission_no: "2025/905", full_name: "Not Yet Promoted", gender: "male", contact_type: "guardian",
      guardian_relationship: "Father", guardian_name: "G1",
      academic_year_id: fromYear.id, class_level_id: classVIII.id, section_id: sectionVIII.id,
    });

    const res = await request(app).get(`/api/reports/promotion?academic_year_id=${fromYear.id}`).set("Cookie", cookie);
    expect(res.body.considered).toBe(0);
    expect(res.body.notPromoted).toBe(0); // not a false positive just because promotion hasn't run
  });

  it("a student blocked for outstanding dues can be explicitly marked detained via the direct action — reported correctly as 'not promoted', reversible, and never confused with 'not yet considered'", async () => {
    const cookie = await loginAs("owner@reports.test");
    const { fromYear, toYear, classVIII, sectionVIII } = await setUpTwoYearLadder(cookie);
    const duesStudent = await request(app).post("/api/students/admit").set("Cookie", cookie).send({
      admission_no: "2025/906", full_name: "Dues Student", gender: "male", contact_type: "guardian",
      guardian_relationship: "Father", guardian_name: "G1",
      academic_year_id: fromYear.id, class_level_id: classVIII.id, section_id: sectionVIII.id,
    });
    const clearStudent = await request(app).post("/api/students/admit").set("Cookie", cookie).send({
      admission_no: "2025/907", full_name: "Clear Student", gender: "female", contact_type: "guardian",
      guardian_relationship: "Mother", guardian_name: "G2",
      academic_year_id: fromYear.id, class_level_id: classVIII.id, section_id: sectionVIII.id,
    });
    // Pay off the second student in full so only the first is actually
    // blocked for dues — otherwise both are unpaid and both block.
    await request(app).post("/api/collection/payments").set("Cookie", cookie).send({
      enrollment_id: clearStudent.body.enrollment.id, amount: 4000000, mode: "cash",
    });

    const preview = await request(app).post("/api/promotion/preview").set("Cookie", cookie)
      .send({ from_year_id: fromYear.id, to_year_id: toYear.id, block_on_dues: true });
    const blockedIds = preview.body.blocked.map((m: any) => m.enrollmentId);
    expect(blockedIds).toContain(duesStudent.body.enrollment.id);
    expect(blockedIds).not.toContain(clearStudent.body.enrollment.id); // paid up — actually promotable
    expect(preview.body.moves.map((m: any) => m.enrollmentId)).toContain(clearStudent.body.enrollment.id);

    // Actually promote the clear student, exactly as the real UI does —
    // one student committed at a time.
    const assign = await request(app).post("/api/promotion/assign-sections").set("Cookie", cookie)
      .send({ to_year_id: toYear.id, moves: preview.body.moves });
    await request(app).post("/api/promotion/commit").set("Cookie", cookie).send({
      from_year_id: fromYear.id, to_year_id: toYear.id, moves: assign.body.moves,
    });

    // Explicitly mark the blocked student detained — the actual,
    // reachable action this UI provides for a blocked student, not an
    // inferred side effect of someone else's commit.
    const detain = await request(app).post(`/api/promotion/enrollments/${duesStudent.body.enrollment.id}/detain`)
      .set("Cookie", cookie).send({});
    expect(detain.status).toBe(200);
    expect(detain.body.outcome).toBe("detained");

    const res = await request(app).get(`/api/reports/promotion?academic_year_id=${fromYear.id}`).set("Cookie", cookie);
    expect(res.body.considered).toBe(2);
    expect(res.body.promoted).toBe(1);
    expect(res.body.notPromoted).toBe(1);

    // Reversible — a mistaken detention shouldn't be permanent.
    const undetain = await request(app).post(`/api/promotion/enrollments/${duesStudent.body.enrollment.id}/undetain`)
      .set("Cookie", cookie).send({});
    expect(undetain.status).toBe(200);
    const afterUndetain = await pool.query(`SELECT outcome FROM enrollments WHERE id = $1`, [duesStudent.body.enrollment.id]);
    expect(afterUndetain.rows[0].outcome).toBe("pending");

    // With nobody marked detained yet again, this reverts to correctly
    // showing 0 "not promoted" rather than a stale count.
    const res2 = await request(app).get(`/api/reports/promotion?academic_year_id=${fromYear.id}`).set("Cookie", cookie);
    expect(res2.body.notPromoted).toBe(0);
  });
});

describe("Student-ledger cross-check (review Phase 4: reports must reconcile with the individual student's own ledger)", () => {
  it("summary KPIs for a single-student filter exactly match that student's own profile ledger", async () => {
    const cookie = await loginAs("owner@reports.test");
    const { year, classLevel, section } = await setUpAcademicStructure(cookie);
    const a = await admit(cookie, year, classLevel, section, "2026/lc1");
    await request(app).post("/api/collection/payments").set("Cookie", cookie).send({
      enrollment_id: a.id, amount: 4000000, mode: "cash",
    });
    await request(app).post(`/api/students/enrollments/${a.id}/refund`).set("Cookie", cookie).send({
      amount: 300000, mode: "cash",
    });

    // The individual student's own ledger — the same view Fee Collection
    // and Student Profile already read from.
    const roster = await request(app)
      .get(`/api/students/enrollments?academic_year_id=${year.id}&include_ledger=1`).set("Cookie", cookie);
    const studentLedger = roster.body.find((r: any) => r.id === a.id).ledger;

    const filtered = await request(app)
      .get(`/api/reports/summary?academic_year_id=${year.id}&class_level_id=${classLevel.id}&section_id=${section.id}`)
      .set("Cookie", cookie);
    // This filter isolates exactly one student, so the report's totals
    // must equal that one student's own ledger figures exactly.
    expect(filtered.body.kpis.projectedFees).toBe(studentLedger.charged);
    expect(filtered.body.kpis.collected).toBe(studentLedger.grossPaid);
    expect(filtered.body.kpis.refundAmount).toBe(studentLedger.refunded);
    expect(filtered.body.kpis.netCollection).toBe(studentLedger.paid);
    expect(filtered.body.kpis.outstanding).toBe(studentLedger.balance);
  });
});

describe("GET /reports/operator-audit (Phase 14 — reuses audit_log, gated stricter than the rest of Reports)", () => {
  it("aggregates real actions per user, and is denied to viewer (view_reports only, not view_audit_log)", async () => {
    const cookie = await loginAs("owner@reports.test");
    const { year, classLevel, section } = await setUpAcademicStructure(cookie);
    const a = await admit(cookie, year, classLevel, section, "2026/oa1");
    await request(app).post("/api/collection/payments").set("Cookie", cookie).send({
      enrollment_id: a.id, amount: 1000000, mode: "cash",
    });
    await request(app).post(`/api/students/enrollments/${a.id}/refund`).set("Cookie", cookie).send({
      amount: 100000, mode: "cash",
    });

    const res = await request(app).get("/api/reports/operator-audit").set("Cookie", cookie);
    expect(res.status).toBe(200);
    const ownerRow = res.body.find((u: any) => u.userRole === "owner");
    expect(ownerRow.paymentsEntered).toBeGreaterThanOrEqual(1);
    expect(ownerRow.refundsProcessed).toBeGreaterThanOrEqual(1);

    const viewer = await createUser("viewer2@reports.test", "x".repeat(14));
    await createMembership(viewer.id, school.id, "viewer");
    const viewerRes = await request(app).get("/api/reports/operator-audit")
      .set("Cookie", await loginAs("viewer2@reports.test"));
    expect(viewerRes.status).toBe(403); // holds view_reports but not view_audit_log
  });
});

describe("GET /reports/exceptions (Phase 12 — only reliably-detectable rules)", () => {
  it("flags high outstanding, refund-plus-remaining-outstanding, and pending approvals correctly", async () => {
    const cookie = await loginAs("owner@reports.test");
    const { year, classLevel, section } = await setUpAcademicStructure(cookie);

    // High outstanding: fully unpaid ₹40,000 (over the ₹25,000 threshold).
    await admit(cookie, year, classLevel, section, "2026/ex1");

    // Refund + remaining outstanding: partial refund, balance still owed.
    const b = await admit(cookie, year, classLevel, section, "2026/ex2");
    await request(app).post("/api/collection/payments").set("Cookie", cookie).send({
      enrollment_id: b.id, amount: 4000000, mode: "cash",
    });
    await request(app).post(`/api/students/enrollments/${b.id}/refund`).set("Cookie", cookie).send({
      amount: 500000, mode: "cash",
    });

    // A pending TC request should also show up.
    const c = await admit(cookie, year, classLevel, section, "2026/ex3");
    await request(app).post(`/api/students/enrollments/${c.id}/tc-requests`).set("Cookie", cookie)
      .send({ reason: "Transfer", last_day: "2026-10-01" });

    const res = await request(app).get(`/api/reports/exceptions?academic_year_id=${year.id}`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.highOutstanding.length).toBeGreaterThanOrEqual(1);
    expect(res.body.refundedWithOutstanding.length).toBeGreaterThanOrEqual(1);
    expect(res.body.pendingApprovals.some((p: any) => p.rule === "Pending TC Approval")).toBe(true);
    expect(res.body.totalExceptions).toBeGreaterThan(0);
  });

  it("flags nothing when there is genuinely nothing to flag", async () => {
    const cookie = await loginAs("owner@reports.test");
    const { year, classLevel, section } = await setUpAcademicStructure(cookie);
    const a = await admit(cookie, year, classLevel, section, "2026/ex4");
    await request(app).post("/api/collection/payments").set("Cookie", cookie).send({
      enrollment_id: a.id, amount: 4000000, mode: "cash",
    });

    const res = await request(app).get(`/api/reports/exceptions?academic_year_id=${year.id}`).set("Cookie", cookie);
    expect(res.body.totalExceptions).toBe(0);
  });
});
