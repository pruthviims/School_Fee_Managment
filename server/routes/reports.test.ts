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
});
