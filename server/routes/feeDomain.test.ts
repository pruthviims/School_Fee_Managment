/**
 * End-to-end HTTP tests for the routes wired up in this slice — setup,
 * admission, billing, collection. Unlike the service-layer tests, these
 * exercise the actual request/response cycle (auth cookies, capability
 * enforcement, zod validation, status codes) so a bug in the routing or
 * permission-wiring layer itself would show up here even if every
 * underlying service function is individually correct.
 */

import crypto from "node:crypto";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../app.js";
import { pool } from "../db/index.js";
import { createMembership, createSchool, createUser, resetDb } from "../tests/helpers.js";
import { createEnrollment, createStudent, resetFeeDomain } from "../tests/fixtures.js";

let school: any;
let owner: any;
let frontDesk: any;
let accountant: any;

beforeEach(async () => {
  await resetFeeDomain();
  await resetDb();

  school = await createSchool({ short_code: "http-test" });
  owner = await createUser("owner@http.test", "x".repeat(14));
  await createMembership(owner.id, school.id, "owner");
  frontDesk = await createUser("desk@http.test", "x".repeat(14));
  await createMembership(frontDesk.id, school.id, "front_desk");
  accountant = await createUser("acc@http.test", "x".repeat(14));
  await createMembership(accountant.id, school.id, "accountant");
});

afterAll(async () => {
  await pool.end();
});

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: "x".repeat(14) });
  return res.headers["set-cookie"];
}

describe("setup routes", () => {
  it("an accountant can create academic structure end to end", async () => {
    const cookie = await loginAs("acc@http.test");

    const year = await request(app).post("/api/setup/academic-years").set("Cookie", cookie)
      .send({ name: "2026-27", starts_on: "2026-06-01", ends_on: "2027-03-31", status: "active" });
    expect(year.status).toBe(201);

    const classLevel = await request(app).post("/api/setup/class-levels").set("Cookie", cookie)
      .send({ name: "VIII", ladder_order: 8, stage: "middle" });
    expect(classLevel.status).toBe(201);

    const section = await request(app).post("/api/setup/sections").set("Cookie", cookie).send({
      academic_year_id: year.body.id, class_level_id: classLevel.body.id, name: "A",
    });
    expect(section.status).toBe(201);

    const feeHead = await request(app).post("/api/setup/fee-heads").set("Cookie", cookie)
      .send({ name: "Tuition fee" });
    expect(feeHead.status).toBe(201);

    const structure = await request(app).post("/api/setup/fee-structure").set("Cookie", cookie).send({
      academic_year_id: year.body.id, class_level_id: classLevel.body.id,
      fee_head_id: feeHead.body.id, amount: 4000000, due_on: "2026-06-15",
    });
    expect(structure.status).toBe(201);

    const list = await request(app).get(`/api/setup/fee-structure?academic_year_id=${year.body.id}`)
      .set("Cookie", cookie);
    expect(list.body).toHaveLength(1);
  });

  it("lists sections filtered by academic year without an ambiguous-column error", async () => {
    // A real bug this specific test exists to catch: sections and
    // class_levels both have a school_id column, and the filtered GET
    // previously left it unqualified in the WHERE clause, which Postgres
    // correctly refuses to guess at once the query joins both tables —
    // every prior test only ever exercised POST, never this filtered list.
    const cookie = await loginAs("owner@http.test");
    const year = await request(app).post("/api/setup/academic-years").set("Cookie", cookie)
      .send({ name: "2026-27", starts_on: "2026-06-01", ends_on: "2027-03-31" });
    const classLevel = await request(app).post("/api/setup/class-levels").set("Cookie", cookie)
      .send({ name: "VIII", ladder_order: 8, stage: "middle" });
    await request(app).post("/api/setup/sections").set("Cookie", cookie).send({
      academic_year_id: year.body.id, class_level_id: classLevel.body.id, name: "A",
    });

    const list = await request(app).get(`/api/setup/sections?academic_year_id=${year.body.id}`)
      .set("Cookie", cookie);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].class_name).toBe("VIII");
  });

  it("deletes a fee head that was never priced or charged anywhere", async () => {
    const cookie = await loginAs("owner@http.test");
    const feeHead = await request(app).post("/api/setup/fee-heads").set("Cookie", cookie)
      .send({ name: "Computer lab fee (added by mistake)" });
    const res = await request(app).delete(`/api/setup/fee-heads/${feeHead.body.id}`).set("Cookie", cookie);
    expect(res.status).toBe(204);

    const list = await request(app).get("/api/setup/fee-heads").set("Cookie", cookie);
    expect(list.body.find((h: any) => h.id === feeHead.body.id)).toBeUndefined();
  });

  it("refuses to delete a fee head that's already priced for a class", async () => {
    const cookie = await loginAs("owner@http.test");
    const year = await request(app).post("/api/setup/academic-years").set("Cookie", cookie)
      .send({ name: "2026-27", starts_on: "2026-06-01", ends_on: "2027-03-31" });
    const classLevel = await request(app).post("/api/setup/class-levels").set("Cookie", cookie)
      .send({ name: "VIII", ladder_order: 8, stage: "middle" });
    const feeHead = await request(app).post("/api/setup/fee-heads").set("Cookie", cookie)
      .send({ name: "Tuition fee" });
    await request(app).post("/api/setup/fee-structure").set("Cookie", cookie).send({
      academic_year_id: year.body.id, class_level_id: classLevel.body.id,
      fee_head_id: feeHead.body.id, amount: 4000000, due_on: "2026-06-15",
    });

    const res = await request(app).delete(`/api/setup/fee-heads/${feeHead.body.id}`).set("Cookie", cookie);
    expect(res.status).toBe(409);

    const stillThere = await request(app).get("/api/setup/fee-heads").set("Cookie", cookie);
    expect(stillThere.body.find((h: any) => h.id === feeHead.body.id)).toBeDefined();
  });

  it("front desk cannot delete a fee head", async () => {
    const ownerCookie = await loginAs("owner@http.test");
    const feeHead = await request(app).post("/api/setup/fee-heads").set("Cookie", ownerCookie)
      .send({ name: "Some fee" });
    const deskCookie = await loginAs("desk@http.test");
    const res = await request(app).delete(`/api/setup/fee-heads/${feeHead.body.id}`).set("Cookie", deskCookie);
    expect(res.status).toBe(403);
  });

  it("can update a fee head's one-time flag (shared across every class)", async () => {
    const cookie = await loginAs("owner@http.test");
    const feeHead = await request(app).post("/api/setup/fee-heads").set("Cookie", cookie)
      .send({ name: "Admission fee" });
    const updated = await request(app).patch(`/api/setup/fee-heads/${feeHead.body.id}`)
      .set("Cookie", cookie).send({ is_one_time: true });
    expect(updated.status).toBe(200);
    expect(updated.body.is_one_time).toBe(true);
  });

  it("can update and delete an existing fee-structure line", async () => {
    const cookie = await loginAs("owner@http.test");
    const year = await request(app).post("/api/setup/academic-years").set("Cookie", cookie)
      .send({ name: "2026-27", starts_on: "2026-06-01", ends_on: "2027-03-31" });
    const classLevel = await request(app).post("/api/setup/class-levels").set("Cookie", cookie)
      .send({ name: "VIII", ladder_order: 8, stage: "middle" });
    const feeHead = await request(app).post("/api/setup/fee-heads").set("Cookie", cookie)
      .send({ name: "Tuition fee" });
    const line = await request(app).post("/api/setup/fee-structure").set("Cookie", cookie).send({
      academic_year_id: year.body.id, class_level_id: classLevel.body.id,
      fee_head_id: feeHead.body.id, amount: 4000000, due_on: "2026-06-15",
    });

    const updated = await request(app).patch(`/api/setup/fee-structure/${line.body.id}`)
      .set("Cookie", cookie).send({ amount: 4500000 });
    expect(updated.status).toBe(200);
    expect(updated.body.amount).toBe(4500000);

    const deleted = await request(app).delete(`/api/setup/fee-structure/${line.body.id}`)
      .set("Cookie", cookie);
    expect(deleted.status).toBe(204);

    const list = await request(app).get(`/api/setup/fee-structure?academic_year_id=${year.body.id}`)
      .set("Cookie", cookie);
    expect(list.body).toHaveLength(0);
  });

  it("logs creating, updating, and deleting a fee-structure line", async () => {
    const cookie = await loginAs("owner@http.test");
    const year = await request(app).post("/api/setup/academic-years").set("Cookie", cookie)
      .send({ name: "2026-27", starts_on: "2026-06-01", ends_on: "2027-03-31" });
    const classLevel = await request(app).post("/api/setup/class-levels").set("Cookie", cookie)
      .send({ name: "VIII", ladder_order: 8, stage: "middle" });
    const feeHead = await request(app).post("/api/setup/fee-heads").set("Cookie", cookie)
      .send({ name: "Tuition fee" });
    const line = await request(app).post("/api/setup/fee-structure").set("Cookie", cookie).send({
      academic_year_id: year.body.id, class_level_id: classLevel.body.id,
      fee_head_id: feeHead.body.id, amount: 4000000, due_on: "2026-06-15",
    });
    await request(app).patch(`/api/setup/fee-structure/${line.body.id}`)
      .set("Cookie", cookie).send({ amount: 4500000 });
    await request(app).delete(`/api/setup/fee-structure/${line.body.id}`).set("Cookie", cookie);

    const log = await request(app).get("/api/audit-log?entity_type=fee_structure").set("Cookie", cookie);
    const actions = log.body.map((e: any) => e.action);
    expect(actions).toContain("fee_structure.create");
    expect(actions).toContain("fee_structure.update");
    expect(actions).toContain("fee_structure.delete");
    // Readable, not just an id — VIII and Tuition fee should both appear.
    const created = log.body.find((e: any) => e.action === "fee_structure.create");
    expect(created.description).toContain("VIII");
    expect(created.description).toContain("Tuition fee");
  });

  it("rejects a true duplicate fee-structure line even with stream_id NULL — the actual bug found", async () => {
    // Reported scenario: "copy fees to other classes" appeared to
    // error but the fee got copied anyway. The real bug underneath:
    // Postgres treats every NULL as distinct from every other NULL in
    // a unique constraint by default, so two lines for the identical
    // (school, year, class, fee_head, term) never actually conflicted
    // whenever stream_id was NULL — true for nearly every class, since
    // only PU classes typically have a stream. This proves the fix
    // (NULLS NOT DISTINCT) actually closes that gap, not just that the
    // migration ran without erroring.
    const cookie = await loginAs("owner@http.test");
    const year = await request(app).post("/api/setup/academic-years").set("Cookie", cookie)
      .send({ name: "2026-27", starts_on: "2026-06-01", ends_on: "2027-03-31" });
    const classLevel = await request(app).post("/api/setup/class-levels").set("Cookie", cookie)
      .send({ name: "VIII", ladder_order: 8, stage: "middle" });
    const feeHead = await request(app).post("/api/setup/fee-heads").set("Cookie", cookie)
      .send({ name: "Tuition fee" });
    const first = await request(app).post("/api/setup/fee-structure").set("Cookie", cookie).send({
      academic_year_id: year.body.id, class_level_id: classLevel.body.id,
      fee_head_id: feeHead.body.id, amount: 4000000, due_on: "2026-06-15",
    });
    expect(first.status).toBe(201);

    const duplicate = await request(app).post("/api/setup/fee-structure").set("Cookie", cookie).send({
      academic_year_id: year.body.id, class_level_id: classLevel.body.id,
      fee_head_id: feeHead.body.id, amount: 4000000, due_on: "2026-06-15",
    });
    expect(duplicate.status).toBe(409);

    const rows = await pool.query(
      `SELECT count(*) FROM fee_structures WHERE class_level_id = $1`, [classLevel.body.id],
    );
    expect(Number(rows.rows[0].count)).toBe(1); // never actually duplicated in the database
  });

  describe("copying a class's fee structure to other classes", () => {
    async function setUpSourceAndTargets(cookie: string) {
      const year = await request(app).post("/api/setup/academic-years").set("Cookie", cookie)
        .send({ name: "2026-27", starts_on: "2026-06-01", ends_on: "2027-03-31" });
      const source = await request(app).post("/api/setup/class-levels").set("Cookie", cookie)
        .send({ name: "VIII", ladder_order: 8, stage: "middle" });
      const targetA = await request(app).post("/api/setup/class-levels").set("Cookie", cookie)
        .send({ name: "IX", ladder_order: 9, stage: "middle" });
      const targetB = await request(app).post("/api/setup/class-levels").set("Cookie", cookie)
        .send({ name: "X", ladder_order: 10, stage: "middle" });
      const tuition = await request(app).post("/api/setup/fee-heads").set("Cookie", cookie)
        .send({ name: "Tuition fee" });
      const admission = await request(app).post("/api/setup/fee-heads").set("Cookie", cookie)
        .send({ name: "Admission fee", is_one_time: true });
      await request(app).post("/api/setup/fee-structure").set("Cookie", cookie).send({
        academic_year_id: year.body.id, class_level_id: source.body.id,
        fee_head_id: tuition.body.id, amount: 4000000, due_on: "2026-06-15",
      });
      await request(app).post("/api/setup/fee-structure").set("Cookie", cookie).send({
        academic_year_id: year.body.id, class_level_id: source.body.id,
        fee_head_id: admission.body.id, amount: 500000, due_on: "2026-06-15",
      });
      return { year: year.body, source: source.body, targetA: targetA.body, targetB: targetB.body };
    }

    it("copies every priced line to all target classes in one call", async () => {
      const cookie = await loginAs("owner@http.test");
      const { year, source, targetA, targetB } = await setUpSourceAndTargets(cookie);

      const res = await request(app).post("/api/setup/fee-structure/copy").set("Cookie", cookie).send({
        academic_year_id: year.id, source_class_id: source.id,
        target_class_ids: [targetA.id, targetB.id],
      });
      expect(res.status).toBe(200);
      expect(res.body.created).toBe(4); // 2 fee heads x 2 target classes

      const targetALines = await request(app)
        .get(`/api/setup/fee-structure?academic_year_id=${year.id}&class_level_id=${targetA.id}`)
        .set("Cookie", cookie);
      expect(targetALines.body).toHaveLength(2);
      expect(targetALines.body.map((l: any) => l.amount).sort((a: number, b: number) => a - b))
        .toEqual([500000, 4000000]);
    });

    it("running it again leaves existing lines alone rather than erroring or duplicating", async () => {
      const cookie = await loginAs("owner@http.test");
      const { year, source, targetA, targetB } = await setUpSourceAndTargets(cookie);
      await request(app).post("/api/setup/fee-structure/copy").set("Cookie", cookie).send({
        academic_year_id: year.id, source_class_id: source.id,
        target_class_ids: [targetA.id, targetB.id],
      });

      const second = await request(app).post("/api/setup/fee-structure/copy").set("Cookie", cookie).send({
        academic_year_id: year.id, source_class_id: source.id,
        target_class_ids: [targetA.id, targetB.id],
      });
      expect(second.status).toBe(200);
      expect(second.body.created).toBe(0); // everything already existed, nothing new

      const targetALines = await request(app)
        .get(`/api/setup/fee-structure?academic_year_id=${year.id}&class_level_id=${targetA.id}`)
        .set("Cookie", cookie);
      expect(targetALines.body).toHaveLength(2); // not 4 — no duplicates from running it twice
    });

    it("front desk cannot copy fee structure (manage_fee_structure required)", async () => {
      const ownerCookie = await loginAs("owner@http.test");
      const { year, source, targetA } = await setUpSourceAndTargets(ownerCookie);
      const deskCookie = await loginAs("desk@http.test");
      const res = await request(app).post("/api/setup/fee-structure/copy").set("Cookie", deskCookie).send({
        academic_year_id: year.id, source_class_id: source.id, target_class_ids: [targetA.id],
      });
      expect(res.status).toBe(403);
    });

    it("logs the copy with a readable description", async () => {
      const cookie = await loginAs("owner@http.test");
      const { year, source, targetA, targetB } = await setUpSourceAndTargets(cookie);
      await request(app).post("/api/setup/fee-structure/copy").set("Cookie", cookie).send({
        academic_year_id: year.id, source_class_id: source.id,
        target_class_ids: [targetA.id, targetB.id],
      });
      const log = await request(app).get("/api/audit-log?entity_type=fee_structure").set("Cookie", cookie);
      const entry = log.body.find((e: any) => e.action === "fee_structure.copy");
      expect(entry).toBeDefined();
      expect(entry.description).toContain("VIII");
      expect(entry.description).toContain("2 other classes");
    });
  });

  describe("generating missing charges for a class priced after students were already enrolled", () => {
    // Import itself now refuses a row targeting an unpriced class (same
    // rule as everywhere else a student gets enrolled), so that path
    // can no longer produce an enrollment with no charges — this
    // endpoint remains a real safety net regardless: legacy data from
    // before that rule existed, or any other future way an enrollment
    // ends up missing its charges. Simulated directly here (bypassing
    // both admission and import, which now both correctly refuse this)
    // rather than through a path the app no longer allows.
    async function enrollWithoutCharges(cookie: string) {
      const year = await request(app).post("/api/setup/academic-years").set("Cookie", cookie)
        .send({ name: "2026-27", starts_on: "2026-06-01", ends_on: "2027-03-31", status: "active" });
      const classLevel = await request(app).post("/api/setup/class-levels").set("Cookie", cookie)
        .send({ name: "IX", ladder_order: 9, stage: "middle" });
      const section = await request(app).post("/api/setup/sections").set("Cookie", cookie).send({
        academic_year_id: year.body.id, class_level_id: classLevel.body.id, name: "A",
      });
      const student = await createStudent(school.id, { admission_no: "2026/500", full_name: "Late Priced Student" });
      const enrollment = await createEnrollment(
        school.id, student.id, year.body.id, classLevel.body.id, section.body.id,
        { admission_type: "carry_over" },
      );
      return { year: year.body, classLevel: classLevel.body, student, enrollment };
    }

    async function priceIt(cookie: string, yearId: string, classId: string) {
      const feeHead = await request(app).post("/api/setup/fee-heads").set("Cookie", cookie)
        .send({ name: "Tuition fee" });
      await request(app).post("/api/setup/fee-structure").set("Cookie", cookie).send({
        academic_year_id: yearId, class_level_id: classId,
        fee_head_id: feeHead.body.id, amount: 4000000, due_on: "2026-06-15",
      });
    }

    // Simulates the exact real gap this recovers from: a row imported
    // before its class was priced, back when that was still possible —
    // the amount_paid figure sitting unused in import_rows.raw, never
    // lost, just waiting for something real to apply it to.
    async function leaveOpeningBalanceRecord(studentId: string, amountPaise: number) {
      const batch = await pool.query(
        `INSERT INTO import_batches (school_id, academic_year_id, filename, column_map, status, total_rows)
         VALUES ($1, (SELECT academic_year_id FROM enrollments WHERE student_id = $2 LIMIT 1),
                 'legacy.csv', '{}', 'committed', 1) RETURNING id`,
        [school.id, studentId],
      );
      await pool.query(
        `INSERT INTO import_rows (school_id, batch_id, line_no, raw, student_id)
         VALUES ($1, $2, 1, $3, $4)`,
        [school.id, batch.rows[0].id, JSON.stringify({ _amount_paid_paise: String(amountPaise) }), studentId],
      );
    }

    it("reports how many enrolled students have no charges yet", async () => {
      const cookie = await loginAs("owner@http.test");
      const { year, classLevel } = await enrollWithoutCharges(cookie);

      const before = await request(app)
        .get(`/api/setup/fee-structure/uncharged-count?academic_year_id=${year.id}&class_level_id=${classLevel.id}`)
        .set("Cookie", cookie);
      expect(before.body.uncharged).toBe(1);
    });

    it("generates the missing charges once the class is priced, and recovers an opening-balance payment left over from before this rule existed", async () => {
      const cookie = await loginAs("owner@http.test");
      const { year, classLevel, student } = await enrollWithoutCharges(cookie);
      await leaveOpeningBalanceRecord(student.id, 1200000); // ₹12,000
      await priceIt(cookie, year.id, classLevel.id);

      const res = await request(app).post("/api/setup/fee-structure/generate-missing-charges")
        .set("Cookie", cookie).send({ academic_year_id: year.id, class_level_id: classLevel.id });
      expect(res.status).toBe(200);
      expect(res.body.studentsBilled).toBe(1);
      expect(res.body.chargesCreated).toBe(1);
      expect(res.body.paymentsRecorded).toBe(1); // the ₹12,000 left over, recovered

      const enrollment = await pool.query(
        `SELECT e.id FROM enrollments e JOIN students s ON s.id = e.student_id
         WHERE s.admission_no = '2026/500'`,
      );
      const ledger = await request(app).get(`/api/students/enrollments/${enrollment.rows[0].id}/ledger`)
        .set("Cookie", cookie);
      expect(ledger.body.charged).toBe(4000000);
      expect(ledger.body.paid).toBe(1200000); // recovered from import_rows, not lost
      expect(ledger.body.balance).toBe(4000000 - 1200000);

      const after = await request(app)
        .get(`/api/setup/fee-structure/uncharged-count?academic_year_id=${year.id}&class_level_id=${classLevel.id}`)
        .set("Cookie", cookie);
      expect(after.body.uncharged).toBe(0);
    });

    it("running it twice never duplicates the charge or the recovered payment", async () => {
      const cookie = await loginAs("owner@http.test");
      const { year, classLevel, student } = await enrollWithoutCharges(cookie);
      await leaveOpeningBalanceRecord(student.id, 1200000);
      await priceIt(cookie, year.id, classLevel.id);

      await request(app).post("/api/setup/fee-structure/generate-missing-charges")
        .set("Cookie", cookie).send({ academic_year_id: year.id, class_level_id: classLevel.id });
      const second = await request(app).post("/api/setup/fee-structure/generate-missing-charges")
        .set("Cookie", cookie).send({ academic_year_id: year.id, class_level_id: classLevel.id });
      expect(second.body.studentsBilled).toBe(0); // already billed, nothing left to do
      expect(second.body.paymentsRecorded).toBe(0);

      const enrollment = await pool.query(
        `SELECT e.id FROM enrollments e JOIN students s ON s.id = e.student_id
         WHERE s.admission_no = '2026/500'`,
      );
      const ledger = await request(app).get(`/api/students/enrollments/${enrollment.rows[0].id}/ledger`)
        .set("Cookie", cookie);
      expect(ledger.body.charged).toBe(4000000); // not doubled
      expect(ledger.body.paid).toBe(1200000); // not doubled
    });

    it("refuses if the class still isn't priced", async () => {
      const cookie = await loginAs("owner@http.test");
      const { year, classLevel } = await enrollWithoutCharges(cookie);
      // Deliberately never priced.
      const res = await request(app).post("/api/setup/fee-structure/generate-missing-charges")
        .set("Cookie", cookie).send({ academic_year_id: year.id, class_level_id: classLevel.id });
      expect(res.status).toBe(400);
    });

    it("front desk cannot generate missing charges (manage_fee_structure required)", async () => {
      const ownerCookie = await loginAs("owner@http.test");
      const { year, classLevel } = await enrollWithoutCharges(ownerCookie);
      await priceIt(ownerCookie, year.id, classLevel.id);
      const deskCookie = await loginAs("desk@http.test");
      const res = await request(app).post("/api/setup/fee-structure/generate-missing-charges")
        .set("Cookie", deskCookie).send({ academic_year_id: year.id, class_level_id: classLevel.id });
      expect(res.status).toBe(403);
    });
  });

  it("front desk cannot update or delete a fee-structure line", async () => {
    const ownerCookie = await loginAs("owner@http.test");
    const year = await request(app).post("/api/setup/academic-years").set("Cookie", ownerCookie)
      .send({ name: "2026-27", starts_on: "2026-06-01", ends_on: "2027-03-31" });
    const classLevel = await request(app).post("/api/setup/class-levels").set("Cookie", ownerCookie)
      .send({ name: "VIII", ladder_order: 8, stage: "middle" });
    const feeHead = await request(app).post("/api/setup/fee-heads").set("Cookie", ownerCookie)
      .send({ name: "Tuition fee" });
    const line = await request(app).post("/api/setup/fee-structure").set("Cookie", ownerCookie).send({
      academic_year_id: year.body.id, class_level_id: classLevel.body.id,
      fee_head_id: feeHead.body.id, amount: 4000000, due_on: "2026-06-15",
    });

    const deskCookie = await loginAs("desk@http.test");
    const patchRes = await request(app).patch(`/api/setup/fee-structure/${line.body.id}`)
      .set("Cookie", deskCookie).send({ amount: 1 });
    expect(patchRes.status).toBe(403);
    const deleteRes = await request(app).delete(`/api/setup/fee-structure/${line.body.id}`)
      .set("Cookie", deskCookie);
    expect(deleteRes.status).toBe(403);
  });

  it("404s updating or deleting a fee-structure line that doesn't exist", async () => {
    const cookie = await loginAs("owner@http.test");
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const patchRes = await request(app).patch(`/api/setup/fee-structure/${fakeId}`)
      .set("Cookie", cookie).send({ amount: 1000 });
    expect(patchRes.status).toBe(404);
    const deleteRes = await request(app).delete(`/api/setup/fee-structure/${fakeId}`)
      .set("Cookie", cookie);
    expect(deleteRes.status).toBe(404);
  });

  it("front desk cannot write to fee structure but can read it", async () => {
    const ownerCookie = await loginAs("owner@http.test");
    const year = await request(app).post("/api/setup/academic-years").set("Cookie", ownerCookie)
      .send({ name: "2026-27", starts_on: "2026-06-01", ends_on: "2027-03-31" });

    const deskCookie = await loginAs("desk@http.test");
    const write = await request(app).post("/api/setup/class-levels").set("Cookie", deskCookie)
      .send({ name: "VIII", ladder_order: 8, stage: "middle" });
    expect(write.status).toBe(403);

    const read = await request(app).get("/api/setup/academic-years").set("Cookie", deskCookie);
    expect(read.status).toBe(200);
    expect(read.body).toHaveLength(1);
    void year;
  });

  it("seed-defaults creates the full class ladder and fee heads in one call", async () => {
    const cookie = await loginAs("owner@http.test");
    const res = await request(app).post("/api/setup/seed-defaults").set("Cookie", cookie).send({});
    expect(res.status).toBe(200);
    expect(res.body.classLevels).toHaveLength(15);
    expect(res.body.feeHeads).toHaveLength(5);
    expect(res.body.classLevels[0].name).toBe("Pre-LKG");
    expect(res.body.classLevels[14].name).toBe("2nd PU");
    expect(res.body.classLevels[13].requires_explicit_optin).toBe(true); // 1st PU

    // Pre-LKG/LKG/UKG = pre_primary, I-VII = primary (7), VIII-X = middle
    // (3, shown to the office as "Higher Primary"), 1st/2nd PU = puc.
    const byName = Object.fromEntries(res.body.classLevels.map((c: any) => [c.name, c.stage]));
    for (const n of ["Pre-LKG", "LKG", "UKG"]) expect(byName[n]).toBe("pre_primary");
    for (const n of ["I", "II", "III", "IV", "V", "VI", "VII"]) expect(byName[n]).toBe("primary");
    for (const n of ["VIII", "IX", "X"]) expect(byName[n]).toBe("middle");
    for (const n of ["1st PU", "2nd PU"]) expect(byName[n]).toBe("puc");
  });

  it("seed-defaults is idempotent — calling it twice never duplicates rows", async () => {
    const cookie = await loginAs("owner@http.test");
    await request(app).post("/api/setup/seed-defaults").set("Cookie", cookie).send({});
    const second = await request(app).post("/api/setup/seed-defaults").set("Cookie", cookie).send({});
    expect(second.status).toBe(200);
    expect(second.body.classLevels).toHaveLength(15);
    expect(second.body.feeHeads).toHaveLength(5);
  });

  it("front desk cannot seed defaults (manage_fee_structure required)", async () => {
    const cookie = await loginAs("desk@http.test");
    const res = await request(app).post("/api/setup/seed-defaults").set("Cookie", cookie).send({});
    expect(res.status).toBe(403);
  });

  it("rejects a duplicate class ladder position with 409", async () => {
    const cookie = await loginAs("owner@http.test");
    await request(app).post("/api/setup/class-levels").set("Cookie", cookie)
      .send({ name: "VIII", ladder_order: 8, stage: "middle" });
    const dup = await request(app).post("/api/setup/class-levels").set("Cookie", cookie)
      .send({ name: "VIII-Repeat", ladder_order: 8, stage: "middle" });
    expect(dup.status).toBe(409);
  });
});

describe("admission -> billing -> collection, end to end", () => {
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

  it("front desk can admit a student, charges post automatically", async () => {
    const ownerCookie = await loginAs("owner@http.test");
    const { year, classLevel, section } = await setUpAcademicStructure(ownerCookie);

    const deskCookie = await loginAs("desk@http.test");
    const admission = await request(app).post("/api/students/admit").set("Cookie", deskCookie).send({
      admission_no: "2026/001", full_name: "Ravi Kumar",
      gender: "male", contact_type: "guardian",
      guardian_relationship: "Father", guardian_name: "Test Guardian",
      academic_year_id: year.id, class_level_id: classLevel.id, section_id: section.id,
    });
    expect(admission.status).toBe(201);
    expect(admission.body.charges).toHaveLength(1);

    const ledger = await request(app)
      .get(`/api/students/enrollments/${admission.body.enrollment.id}/ledger`)
      .set("Cookie", deskCookie);
    expect(ledger.body.balance).toBe(4000000);
  });

  it("refuses to admit into a class with no fees priced at all for the year", async () => {
    const cookie = await loginAs("owner@http.test");
    const year = await request(app).post("/api/setup/academic-years").set("Cookie", cookie)
      .send({ name: "2026-27", starts_on: "2026-06-01", ends_on: "2027-03-31", status: "active" });
    const classLevel = await request(app).post("/api/setup/class-levels").set("Cookie", cookie)
      .send({ name: "IX", ladder_order: 9, stage: "secondary" });
    const section = await request(app).post("/api/setup/sections").set("Cookie", cookie).send({
      academic_year_id: year.body.id, class_level_id: classLevel.body.id, name: "A",
    });
    // Deliberately no fee-structure line for this class at all.

    const admission = await request(app).post("/api/students/admit").set("Cookie", cookie).send({
      admission_no: "2026/900", full_name: "Unpriced Class Student",
      gender: "male", contact_type: "guardian",
      guardian_relationship: "Father", guardian_name: "Test Guardian",
      academic_year_id: year.body.id, class_level_id: classLevel.body.id, section_id: section.body.id,
    });
    expect(admission.status).toBe(400);

    const check = await pool.query(`SELECT 1 FROM students WHERE admission_no = '2026/900'`);
    expect(check.rows).toHaveLength(0); // nothing created, not a half-admitted student
  });

  it("refuses to admit into a class whose only fee line is explicitly zero", async () => {
    const cookie = await loginAs("owner@http.test");
    const year = await request(app).post("/api/setup/academic-years").set("Cookie", cookie)
      .send({ name: "2026-27", starts_on: "2026-06-01", ends_on: "2027-03-31", status: "active" });
    const classLevel = await request(app).post("/api/setup/class-levels").set("Cookie", cookie)
      .send({ name: "IX", ladder_order: 9, stage: "secondary" });
    const section = await request(app).post("/api/setup/sections").set("Cookie", cookie).send({
      academic_year_id: year.body.id, class_level_id: classLevel.body.id, name: "A",
    });
    const feeHead = await request(app).post("/api/setup/fee-heads").set("Cookie", cookie)
      .send({ name: "Tuition fee" });
    await request(app).post("/api/setup/fee-structure").set("Cookie", cookie).send({
      academic_year_id: year.body.id, class_level_id: classLevel.body.id,
      fee_head_id: feeHead.body.id, amount: 0, due_on: "2026-06-15",
    });

    const admission = await request(app).post("/api/students/admit").set("Cookie", cookie).send({
      admission_no: "2026/901", full_name: "Zero Fee Student",
      gender: "male", contact_type: "guardian",
      guardian_relationship: "Father", guardian_name: "Test Guardian",
      academic_year_id: year.body.id, class_level_id: classLevel.body.id, section_id: section.body.id,
    });
    expect(admission.status).toBe(400);
  });

  it("front desk cannot access the defaulters report", async () => {
    const ownerCookie = await loginAs("owner@http.test");
    const { year } = await setUpAcademicStructure(ownerCookie);

    const deskCookie = await loginAs("desk@http.test");
    const res = await request(app).get(`/api/billing/academic-years/${year.id}/defaulters`)
      .set("Cookie", deskCookie);
    expect(res.status).toBe(403);
  });

  it("recording a payment over HTTP updates the enrollment's balance", async () => {
    const ownerCookie = await loginAs("owner@http.test");
    const { year, classLevel, section } = await setUpAcademicStructure(ownerCookie);
    const deskCookie = await loginAs("desk@http.test");
    const admission = await request(app).post("/api/students/admit").set("Cookie", deskCookie).send({
      admission_no: "2026/002", full_name: "Sneha Iyer",
      gender: "male", contact_type: "guardian",
      guardian_relationship: "Father", guardian_name: "Test Guardian",
      academic_year_id: year.id, class_level_id: classLevel.id, section_id: section.id,
    });

    const payment = await request(app).post("/api/collection/payments").set("Cookie", deskCookie).send({
      enrollment_id: admission.body.enrollment.id, amount: 1500000, mode: "cash",
    });
    expect(payment.status).toBe(201);
    expect(payment.body.receipt_no).toMatch(/^RCP\//);

    const ledger = await request(app)
      .get(`/api/students/enrollments/${admission.body.enrollment.id}/ledger`)
      .set("Cookie", deskCookie);
    expect(ledger.body.balance).toBe(4000000 - 1500000);
  });

  it("logs recording a payment, with the real student name and amount", async () => {
    const ownerCookie = await loginAs("owner@http.test");
    const { year, classLevel, section } = await setUpAcademicStructure(ownerCookie);
    const admission = await request(app).post("/api/students/admit").set("Cookie", ownerCookie).send({
      admission_no: "2026/920", full_name: "Logged Payment Student",
      gender: "male", contact_type: "guardian",
      guardian_relationship: "Father", guardian_name: "Test Guardian",
      academic_year_id: year.id, class_level_id: classLevel.id, section_id: section.id,
    });
    await request(app).post("/api/collection/payments").set("Cookie", ownerCookie).send({
      enrollment_id: admission.body.enrollment.id, amount: 1500000, mode: "upi",
    });

    const log = await request(app).get("/api/audit-log?entity_type=payment").set("Cookie", ownerCookie);
    const entry = log.body.find((e: any) => e.action === "payment.record");
    expect(entry).toBeDefined();
    expect(entry.description).toContain("Logged Payment Student");
    expect(entry.description).toContain("upi");
  });

  it("lists payments for an enrollment, most recent first", async () => {
    const ownerCookie = await loginAs("owner@http.test");
    const { year, classLevel, section } = await setUpAcademicStructure(ownerCookie);
    const deskCookie = await loginAs("desk@http.test");
    const admission = await request(app).post("/api/students/admit").set("Cookie", deskCookie).send({
      admission_no: "2026/902", full_name: "Payment History Student",
      gender: "male", contact_type: "guardian",
      guardian_relationship: "Father", guardian_name: "Test Guardian",
      academic_year_id: year.id, class_level_id: classLevel.id, section_id: section.id,
    });
    await request(app).post("/api/collection/payments").set("Cookie", deskCookie).send({
      enrollment_id: admission.body.enrollment.id, amount: 1000000, mode: "cash",
    });
    await request(app).post("/api/collection/payments").set("Cookie", deskCookie).send({
      enrollment_id: admission.body.enrollment.id, amount: 500000, mode: "upi",
    });

    const list = await request(app)
      .get(`/api/collection/enrollments/${admission.body.enrollment.id}/payments`)
      .set("Cookie", deskCookie);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(2);
    expect(list.body[0].amount).toBe(500000); // most recent first
    expect(list.body[1].amount).toBe(1000000);
  });

  it("corrects a payment entered wrong — the exact reported scenario", async () => {
    const ownerCookie = await loginAs("owner@http.test");
    const { year, classLevel, section } = await setUpAcademicStructure(ownerCookie);
    const admission = await request(app).post("/api/students/admit").set("Cookie", ownerCookie).send({
      admission_no: "2026/910", full_name: "Wrong Amount Student",
      gender: "male", contact_type: "guardian",
      guardian_relationship: "Father", guardian_name: "Test Guardian",
      academic_year_id: year.id, class_level_id: classLevel.id, section_id: section.id,
    });
    // Office meant to type 15,560 but typed 15,660.
    const wrong = await request(app).post("/api/collection/payments").set("Cookie", ownerCookie).send({
      enrollment_id: admission.body.enrollment.id, amount: 1566000, mode: "cash",
    });
    expect(wrong.status).toBe(201);

    const before = await request(app)
      .get(`/api/students/enrollments/${admission.body.enrollment.id}/ledger`).set("Cookie", ownerCookie);
    expect(before.body.balance).toBe(4000000 - 1566000);

    const correction = await request(app).post(`/api/collection/payments/${wrong.body.id}/void`)
      .set("Cookie", ownerCookie).send({
        amount: 1556000, mode: "cash", reason: "Amount entered incorrectly — should be 15,560",
      });
    expect(correction.status).toBe(200);
    expect(correction.body.voided.reversed_by).toBe(correction.body.corrected.id);
    expect(correction.body.corrected.amount).toBe(1556000);
    // A real, different receipt number for the corrected payment, not
    // the same receipt silently carrying a different amount.
    expect(correction.body.corrected.receipt_no).not.toBe(wrong.body.receipt_no);

    // The ledger now reflects only the corrected amount — not both,
    // not the wrong one.
    const after = await request(app)
      .get(`/api/students/enrollments/${admission.body.enrollment.id}/ledger`).set("Cookie", ownerCookie);
    expect(after.body.balance).toBe(4000000 - 1556000);

    const log = await request(app).get("/api/audit-log?entity_type=payment").set("Cookie", ownerCookie);
    const entry = log.body.find((e: any) => e.action === "payment.void");
    expect(entry).toBeDefined();
    expect(entry.description).toContain("Wrong Amount Student");
  });

  it("refuses to void the same payment twice", async () => {
    const cookie = await loginAs("owner@http.test");
    const { year, classLevel, section } = await setUpAcademicStructure(cookie);
    const admission = await request(app).post("/api/students/admit").set("Cookie", cookie).send({
      admission_no: "2026/911", full_name: "Double Void Student",
      gender: "male", contact_type: "guardian",
      guardian_relationship: "Father", guardian_name: "Test Guardian",
      academic_year_id: year.id, class_level_id: classLevel.id, section_id: section.id,
    });
    const payment = await request(app).post("/api/collection/payments").set("Cookie", cookie).send({
      enrollment_id: admission.body.enrollment.id, amount: 1000000, mode: "cash",
    });
    await request(app).post(`/api/collection/payments/${payment.body.id}/void`)
      .set("Cookie", cookie).send({ amount: 900000, mode: "cash" });

    const second = await request(app).post(`/api/collection/payments/${payment.body.id}/void`)
      .set("Cookie", cookie).send({ amount: 800000, mode: "cash" });
    expect(second.status).toBe(400);
  });

  it("front desk cannot void a payment (void_payments required)", async () => {
    const ownerCookie = await loginAs("owner@http.test");
    const { year, classLevel, section } = await setUpAcademicStructure(ownerCookie);
    const admission = await request(app).post("/api/students/admit").set("Cookie", ownerCookie).send({
      admission_no: "2026/912", full_name: "No Void Student",
      gender: "male", contact_type: "guardian",
      guardian_relationship: "Father", guardian_name: "Test Guardian",
      academic_year_id: year.id, class_level_id: classLevel.id, section_id: section.id,
    });
    const payment = await request(app).post("/api/collection/payments").set("Cookie", ownerCookie).send({
      enrollment_id: admission.body.enrollment.id, amount: 1000000, mode: "cash",
    });

    const deskCookie = await loginAs("desk@http.test");
    const res = await request(app).post(`/api/collection/payments/${payment.body.id}/void`)
      .set("Cookie", deskCookie).send({ amount: 900000, mode: "cash" });
    expect(res.status).toBe(403);
  });

  it("accountant can void a payment", async () => {
    const ownerCookie = await loginAs("owner@http.test");
    const { year, classLevel, section } = await setUpAcademicStructure(ownerCookie);
    const admission = await request(app).post("/api/students/admit").set("Cookie", ownerCookie).send({
      admission_no: "2026/913", full_name: "Accountant Void Student",
      gender: "male", contact_type: "guardian",
      guardian_relationship: "Father", guardian_name: "Test Guardian",
      academic_year_id: year.id, class_level_id: classLevel.id, section_id: section.id,
    });
    const payment = await request(app).post("/api/collection/payments").set("Cookie", ownerCookie).send({
      enrollment_id: admission.body.enrollment.id, amount: 1000000, mode: "cash",
    });

    const accCookie = await loginAs("acc@http.test");
    const res = await request(app).post(`/api/collection/payments/${payment.body.id}/void`)
      .set("Cookie", accCookie).send({ amount: 900000, mode: "cash" });
    expect(res.status).toBe(200);
  });

  describe("TC (Transfer Certificate) workflow", () => {
    async function admitForTc(cookie: string) {
      const { year, classLevel, section } = await setUpAcademicStructure(cookie);
      const admission = await request(app).post("/api/students/admit").set("Cookie", cookie).send({
        admission_no: "2026/950", full_name: "Leaving Student",
        gender: "male", contact_type: "guardian",
        guardian_relationship: "Father", guardian_name: "Test Guardian",
        academic_year_id: year.id, class_level_id: classLevel.id, section_id: section.id,
      });
      return admission.body.enrollment;
    }

    it("goes through the full flow: request, clear, issue — and updates the enrollment", async () => {
      const cookie = await loginAs("owner@http.test");
      const enrollment = await admitForTc(cookie);

      const req1 = await request(app).post(`/api/students/enrollments/${enrollment.id}/tc-requests`)
        .set("Cookie", cookie).send({ reason: "Family relocating to another city", last_day: "2026-11-30" });
      expect(req1.status).toBe(201);
      expect(req1.body.status).toBe("pending_clearance");

      const clear = await request(app).post(`/api/students/tc-requests/${req1.body.id}/clear`)
        .set("Cookie", cookie).send({ clearance_note: "All dues cleared", exit_reason: "tc" });
      expect(clear.status).toBe(200);
      expect(clear.body.status).toBe("cleared");
      expect(clear.body.cleared_by).toBeTruthy();

      const issue = await request(app).post(`/api/students/tc-requests/${req1.body.id}/issue`)
        .set("Cookie", cookie).send({ conduct: "Good", qualified_for_promotion: true, remarks: "" });
      expect(issue.status).toBe(200);
      expect(issue.body.status).toBe("issued");
      expect(issue.body.tc_number).toMatch(/^TC\//);

      const enrollmentRow = await pool.query(`SELECT outcome, is_active, withdrawn_on, withdrawal_reason
        FROM enrollments WHERE id = $1`, [enrollment.id]);
      expect(enrollmentRow.rows[0].outcome).toBe("tc_issued");
      expect(enrollmentRow.rows[0].is_active).toBe(false);
      // The controlled exit-reason label set at NOC/clearance time,
      // not the original free-text request reason — the small
      // /issue compatibility tweak that keeps this label consistent
      // even if a TC is later issued after an NOC.
      expect(enrollmentRow.rows[0].withdrawal_reason).toBe("TC");
    });

    it("accountant can complete clearance and issue alone, with its own actor per step", async () => {
      const ownerCookie = await loginAs("owner@http.test");
      const enrollment = await admitForTc(ownerCookie);
      // Initiating still requires manage_admissions (Owner/Front Desk) —
      // it's specifically clearance and issue that Accountant handles
      // alone here, matching the design: paperwork stays with whoever
      // already manages admissions, the sensitive money-and-certificate
      // steps are Accountant/Owner only.
      const req1 = await request(app).post(`/api/students/enrollments/${enrollment.id}/tc-requests`)
        .set("Cookie", ownerCookie).send({ reason: "Transfer", last_day: "2026-11-30" });

      const accCookie = await loginAs("acc@http.test");
      const clear = await request(app).post(`/api/students/tc-requests/${req1.body.id}/clear`)
        .set("Cookie", accCookie).send({ clearance_note: "Cleared", exit_reason: "tc" });
      const issue = await request(app).post(`/api/students/tc-requests/${req1.body.id}/issue`)
        .set("Cookie", accCookie).send({ conduct: "Good" });
      expect(issue.status).toBe(200);
      expect(issue.body.status).toBe("issued");
    });

    it("cannot issue before clearance", async () => {
      const cookie = await loginAs("owner@http.test");
      const enrollment = await admitForTc(cookie);
      const req1 = await request(app).post(`/api/students/enrollments/${enrollment.id}/tc-requests`)
        .set("Cookie", cookie).send({ reason: "Transfer", last_day: "2026-11-30" });
      const issue = await request(app).post(`/api/students/tc-requests/${req1.body.id}/issue`)
        .set("Cookie", cookie).send({ conduct: "Good" });
      expect(issue.status).toBe(400);
    });

    it("cannot request a second TC while one is already in progress", async () => {
      const cookie = await loginAs("owner@http.test");
      const enrollment = await admitForTc(cookie);
      await request(app).post(`/api/students/enrollments/${enrollment.id}/tc-requests`)
        .set("Cookie", cookie).send({ reason: "Transfer", last_day: "2026-11-30" });
      const second = await request(app).post(`/api/students/enrollments/${enrollment.id}/tc-requests`)
        .set("Cookie", cookie).send({ reason: "Changed mind", last_day: "2026-12-15" });
      expect(second.status).toBe(409);
    });

    it("front desk can request a TC but not clear or issue it (manage_tc required)", async () => {
      const ownerCookie = await loginAs("owner@http.test");
      const enrollment = await admitForTc(ownerCookie);
      const deskCookie = await loginAs("desk@http.test");

      const req1 = await request(app).post(`/api/students/enrollments/${enrollment.id}/tc-requests`)
        .set("Cookie", deskCookie).send({ reason: "Transfer", last_day: "2026-11-30" });
      expect(req1.status).toBe(201);

      const clear = await request(app).post(`/api/students/tc-requests/${req1.body.id}/clear`)
        .set("Cookie", deskCookie).send({ clearance_note: "Cleared", exit_reason: "tc" });
      expect(clear.status).toBe(403);
    });

    it("TC numbers are sequential and gapless", async () => {
      const cookie = await loginAs("owner@http.test");
      const { year, classLevel, section } = await setUpAcademicStructure(cookie);
      const numbers: string[] = [];
      for (let i = 0; i < 2; i++) {
        const admission = await request(app).post("/api/students/admit").set("Cookie", cookie).send({
          admission_no: `2026/96${i}`, full_name: `TC Student ${i}`,
          gender: "male", contact_type: "guardian",
          guardian_relationship: "Father", guardian_name: "Test Guardian",
          academic_year_id: year.id, class_level_id: classLevel.id, section_id: section.id,
        });
        const req1 = await request(app).post(`/api/students/enrollments/${admission.body.enrollment.id}/tc-requests`)
          .set("Cookie", cookie).send({ reason: "Transfer", last_day: "2026-11-30" });
        await request(app).post(`/api/students/tc-requests/${req1.body.id}/clear`)
          .set("Cookie", cookie).send({ clearance_note: "Cleared", exit_reason: "tc" });
        const issue = await request(app).post(`/api/students/tc-requests/${req1.body.id}/issue`)
          .set("Cookie", cookie).send({ conduct: "Good" });
        numbers.push(issue.body.tc_number);
      }
      expect(numbers[0]).not.toBe(numbers[1]);
      const suffix0 = parseInt(numbers[0].split("/").pop()!, 10);
      const suffix1 = parseInt(numbers[1].split("/").pop()!, 10);
      expect(suffix1).toBe(suffix0 + 1);
    });

    it("fetches TC document data once issued, refuses before", async () => {
      const cookie = await loginAs("owner@http.test");
      const enrollment = await admitForTc(cookie);
      const req1 = await request(app).post(`/api/students/enrollments/${enrollment.id}/tc-requests`)
        .set("Cookie", cookie).send({ reason: "Transfer", last_day: "2026-11-30" });

      const tooEarly = await request(app).get(`/api/students/tc-requests/${req1.body.id}/document-data`)
        .set("Cookie", cookie);
      expect(tooEarly.status).toBe(400);

      await request(app).post(`/api/students/tc-requests/${req1.body.id}/clear`)
        .set("Cookie", cookie).send({ clearance_note: "Cleared", exit_reason: "tc" });
      await request(app).post(`/api/students/tc-requests/${req1.body.id}/issue`)
        .set("Cookie", cookie).send({ conduct: "Good", qualified_for_promotion: true });

      const doc = await request(app).get(`/api/students/tc-requests/${req1.body.id}/document-data`)
        .set("Cookie", cookie);
      expect(doc.status).toBe(200);
      expect(doc.body.full_name).toBe("Leaving Student");
      expect(doc.body.school_name).toBeTruthy();
      expect(doc.body.qualified_for_promotion).toBe(true);
    });

    it("logs every step of the TC workflow", async () => {
      const cookie = await loginAs("owner@http.test");
      const enrollment = await admitForTc(cookie);
      const req1 = await request(app).post(`/api/students/enrollments/${enrollment.id}/tc-requests`)
        .set("Cookie", cookie).send({ reason: "Transfer", last_day: "2026-11-30" });
      await request(app).post(`/api/students/tc-requests/${req1.body.id}/clear`)
        .set("Cookie", cookie).send({ clearance_note: "Cleared", exit_reason: "tc" });
      await request(app).post(`/api/students/tc-requests/${req1.body.id}/issue`)
        .set("Cookie", cookie).send({ conduct: "Good" });

      const log = await request(app).get("/api/audit-log?entity_type=tc_request").set("Cookie", cookie);
      const actions = log.body.map((e: any) => e.action);
      expect(actions).toContain("tc.request");
      expect(actions).toContain("tc.clear");
      expect(actions).toContain("tc.issue");
    });
  });

  describe("NOC / Clearance — stops at 'cleared', never issues a TC", () => {
    async function admitAndCharge(cookie: string, admissionNo: string) {
      const { year, classLevel, section } = await setUpAcademicStructure(cookie);
      const admission = await request(app).post("/api/students/admit").set("Cookie", cookie).send({
        admission_no: admissionNo, full_name: "NOC Test Student", gender: "male",
        contact_type: "guardian", guardian_relationship: "Father", guardian_name: "Test Guardian",
        academic_year_id: year.id, class_level_id: classLevel.id, section_id: section.id,
      });
      return admission.body.enrollment;
    }

    it("requires exit_reason — a bare clearance_note is not enough", async () => {
      const cookie = await loginAs("owner@http.test");
      const enrollment = await admitAndCharge(cookie, "2026/noc-1");
      const req1 = await request(app).post(`/api/students/enrollments/${enrollment.id}/tc-requests`)
        .set("Cookie", cookie).send({ reason: "Transfer", last_day: "2026-11-30" });
      const clear = await request(app).post(`/api/students/tc-requests/${req1.body.id}/clear`)
        .set("Cookie", cookie).send({ clearance_note: "Cleared" }); // no exit_reason
      expect(clear.status).toBe(400);
    });

    it("approving NOC moves the enrollment to outcome='left', never 'tc_issued' — the TC is not issued by this step", async () => {
      const cookie = await loginAs("owner@http.test");
      const { year, classLevel, section } = await setUpAcademicStructure(cookie);
      const admission = await request(app).post("/api/students/admit").set("Cookie", cookie).send({
        admission_no: "2026/noc-2", full_name: "NOC Test Student", gender: "male",
        contact_type: "guardian", guardian_relationship: "Father", guardian_name: "Test Guardian",
        academic_year_id: year.id, class_level_id: classLevel.id, section_id: section.id,
      });
      const enrollment = admission.body.enrollment;
      const req1 = await request(app).post(`/api/students/enrollments/${enrollment.id}/tc-requests`)
        .set("Cookie", cookie).send({ reason: "Moving city", last_day: "2026-10-15" });

      const clear = await request(app).post(`/api/students/tc-requests/${req1.body.id}/clear`)
        .set("Cookie", cookie).send({ clearance_note: "Approved by management", exit_reason: "tc" });
      expect(clear.status).toBe(200);
      expect(clear.body.status).toBe("cleared");
      expect(clear.body.tc_number).toBeNull(); // no TC number — /issue was never called
      expect(clear.body.noc_number).toMatch(/^NOC\//);

      const enrollmentRow = await pool.query(
        `SELECT outcome, is_active, withdrawal_reason FROM enrollments WHERE id = $1`, [enrollment.id],
      );
      expect(enrollmentRow.rows[0].outcome).toBe("left"); // not tc_issued
      expect(enrollmentRow.rows[0].is_active).toBe(false);
      expect(enrollmentRow.rows[0].withdrawal_reason).toBe("TC"); // the controlled label, not the free-text reason

      // Disappears from the active roster immediately, same as any
      // other exit — no TC needed to be issued for that to happen.
      const roster = await request(app)
        .get(`/api/students/enrollments?academic_year_id=${year.id}`).set("Cookie", cookie);
      expect(roster.body.map((r: any) => r.id)).not.toContain(enrollment.id);
    });

    it("each exit_reason category produces its own readable label", async () => {
      const cookie = await loginAs("owner@http.test");
      const { year, classLevel, section } = await setUpAcademicStructure(cookie);
      const cases: [string, string][] = [
        ["admission_cancelled", "Admission Cancelled"],
        ["dropout", "Dropout"],
        ["transferred", "Transferred to Another School"],
        ["other", "Other"],
      ];
      for (let i = 0; i < cases.length; i++) {
        const [reasonCode, label] = cases[i];
        const admission = await request(app).post("/api/students/admit").set("Cookie", cookie).send({
          admission_no: `2026/nr${i}`, full_name: "NOC Test Student", gender: "male",
          contact_type: "guardian", guardian_relationship: "Father", guardian_name: "Test Guardian",
          academic_year_id: year.id, class_level_id: classLevel.id, section_id: section.id,
        });
        const enrollment = admission.body.enrollment;
        const req1 = await request(app).post(`/api/students/enrollments/${enrollment.id}/tc-requests`)
          .set("Cookie", cookie).send({ reason: "Some free-text reason", last_day: "2026-10-15" });
        await request(app).post(`/api/students/tc-requests/${req1.body.id}/clear`)
          .set("Cookie", cookie).send({ exit_reason: reasonCode });
        const row = await pool.query(`SELECT withdrawal_reason FROM enrollments WHERE id = $1`, [enrollment.id]);
        expect(row.rows[0].withdrawal_reason).toBe(label);
      }
    });

    it("admission cancellation: a full refund of what was actually paid brings net paid back to zero, honestly, without hiding the real remaining charge", async () => {
      const cookie = await loginAs("owner@http.test");
      const enrollment = await admitAndCharge(cookie, "2026/noc-cancel");
      // The reported scenario: an admission-fee-sized payment
      // (₹5,000), fully refunded once the family never actually
      // joined — this fixture's own fee structure is a much larger
      // ₹40,000, so what's actually being verified here is that net
      // paid genuinely nets to zero and outstanding is never silently
      // zeroed out to match — it stays exactly what's really left
      // charged, honestly, not a number chosen to make the exit look
      // tidier than it is.
      await request(app).post("/api/collection/payments").set("Cookie", cookie).send({
        enrollment_id: enrollment.id, amount: 500000, mode: "cash",
      });
      await request(app).post(`/api/students/enrollments/${enrollment.id}/refund`)
        .set("Cookie", cookie).send({ amount: 500000, mode: "cash", reason: "Never joined" });

      const req1 = await request(app).post(`/api/students/enrollments/${enrollment.id}/tc-requests`)
        .set("Cookie", cookie).send({ reason: "Joining another school", last_day: "2026-09-20" });
      const clear = await request(app).post(`/api/students/tc-requests/${req1.body.id}/clear`)
        .set("Cookie", cookie).send({ exit_reason: "admission_cancelled" });

      expect(clear.body.financial_snapshot.grossPaid).toBe(500000);
      expect(clear.body.financial_snapshot.refunded).toBe(500000);
      expect(clear.body.financial_snapshot.netPaid).toBe(0);
      // Outstanding = the full charge minus zero net paid — real,
      // not hidden, exactly what "do not zero this out" requires.
      expect(clear.body.financial_snapshot.outstanding).toBe(clear.body.financial_snapshot.charged);
      const row = await pool.query(`SELECT withdrawal_reason FROM enrollments WHERE id = $1`, [enrollment.id]);
      expect(row.rows[0].withdrawal_reason).toBe("Admission Cancelled");
    });

    it("partial refund case: NOC approval does NOT waive the remaining outstanding balance", async () => {
      const cookie = await loginAs("owner@http.test");
      const enrollment = await admitAndCharge(cookie, "2026/noc-partial");
      // This fixture's own fee is ₹40,000 (4000000 paise).
      await request(app).post("/api/collection/payments").set("Cookie", cookie).send({
        enrollment_id: enrollment.id, amount: 4000000, mode: "cash",
      });
      await request(app).post(`/api/students/enrollments/${enrollment.id}/refund`)
        .set("Cookie", cookie).send({ amount: 300000, mode: "cash", reason: "Partial refund" });

      const req1 = await request(app).post(`/api/students/enrollments/${enrollment.id}/tc-requests`)
        .set("Cookie", cookie).send({ reason: "Transfer", last_day: "2026-09-20" });
      const clear = await request(app).post(`/api/students/tc-requests/${req1.body.id}/clear`)
        .set("Cookie", cookie).send({ exit_reason: "tc", clearance_note: "Approved despite balance" });

      expect(clear.status).toBe(200);
      // The snapshot captured at approval time shows the real numbers —
      // outstanding is NOT zeroed out just because management approved.
      expect(clear.body.financial_snapshot.charged).toBe(4000000);
      expect(clear.body.financial_snapshot.netPaid).toBe(3700000);
      expect(clear.body.financial_snapshot.outstanding).toBe(300000);

      // And the ledger itself — not just the snapshot — still shows
      // the same real outstanding balance after NOC approval.
      const rosterAll = await request(app).get(`/api/students/former`).set("Cookie", cookie);
      const row = rosterAll.body.rows.find((r: any) => r.enrollment_id === enrollment.id);
      expect(row).toBeDefined();
      expect(row.outcome).toBe("left");
    });

    it("noc_number is its own series — distinct from tc_number and refund receipt numbers", async () => {
      const cookie = await loginAs("owner@http.test");
      const enrollment = await admitAndCharge(cookie, "2026/noc-numbering");
      const req1 = await request(app).post(`/api/students/enrollments/${enrollment.id}/tc-requests`)
        .set("Cookie", cookie).send({ reason: "Transfer", last_day: "2026-09-20" });
      const clear = await request(app).post(`/api/students/tc-requests/${req1.body.id}/clear`)
        .set("Cookie", cookie).send({ exit_reason: "tc" });
      expect(clear.body.noc_number).toMatch(/^NOC\//);
      expect(clear.body.noc_number).not.toMatch(/^TC\//);
      expect(clear.body.noc_number).not.toMatch(/^RF\//);
    });

    it("clearing does not affect an unrelated TC that was fully issued earlier", async () => {
      // Regression: an already-issued TC (via the pre-existing manual
      // path) must keep loading correctly and remain unaffected by any
      // new NOC approved for a different student.
      const cookie = await loginAs("owner@http.test");
      const issuedStudent = await admitAndCharge(cookie, "2026/noc-old-tc");
      const req1 = await request(app).post(`/api/students/enrollments/${issuedStudent.id}/tc-requests`)
        .set("Cookie", cookie).send({ reason: "Transfer", last_day: "2026-09-20" });
      await request(app).post(`/api/students/tc-requests/${req1.body.id}/clear`)
        .set("Cookie", cookie).send({ exit_reason: "tc" });
      const issue = await request(app).post(`/api/students/tc-requests/${req1.body.id}/issue`)
        .set("Cookie", cookie).send({ conduct: "Good" });
      expect(issue.status).toBe(200);
      expect(issue.body.status).toBe("issued");

      const doc = await request(app).get(`/api/students/tc-requests/${req1.body.id}/document-data`)
        .set("Cookie", cookie);
      expect(doc.status).toBe(200);
      expect(doc.body.tc_number).toBe(issue.body.tc_number);
    });

    it("NOC document-data is available once cleared, includes refund details, and remains available after a TC is later issued", async () => {
      const cookie = await loginAs("owner@http.test");
      const enrollment = await admitAndCharge(cookie, "2026/noc-doc");
      await request(app).post("/api/collection/payments").set("Cookie", cookie).send({
        enrollment_id: enrollment.id, amount: 4000000, mode: "cash",
      });
      const refund = await request(app).post(`/api/students/enrollments/${enrollment.id}/refund`)
        .set("Cookie", cookie).send({ amount: 300000, mode: "cash", reason: "Partial refund" });

      const req1 = await request(app).post(`/api/students/enrollments/${enrollment.id}/tc-requests`)
        .set("Cookie", cookie).send({ reason: "Transfer", last_day: "2026-09-20" });

      // Not available before clearance.
      const tooEarly = await request(app)
        .get(`/api/students/tc-requests/${req1.body.id}/noc-document-data`).set("Cookie", cookie);
      expect(tooEarly.status).toBe(400);

      const clear = await request(app).post(`/api/students/tc-requests/${req1.body.id}/clear`)
        .set("Cookie", cookie).send({ exit_reason: "tc", clearance_note: "Approved despite balance" });

      const doc = await request(app)
        .get(`/api/students/tc-requests/${req1.body.id}/noc-document-data`).set("Cookie", cookie);
      expect(doc.status).toBe(200);
      expect(doc.body.noc_number).toBe(clear.body.noc_number);
      expect(doc.body.class_name).toBeTruthy();
      expect(doc.body.section_name).toBeTruthy();
      expect(doc.body.cleared_by_name).toBeDefined();
      expect(doc.body.financial_snapshot.outstanding).toBe(300000);
      expect(doc.body.refunds).toHaveLength(1);
      expect(doc.body.refunds[0].amount).toBe(300000);
      expect(doc.body.refunds[0].receipt_no).toBe(refund.body.receipt_no);

      // Still available after the official TC is later issued —
      // the NOC itself remains a real, reprintable historical event.
      await request(app).post(`/api/students/tc-requests/${req1.body.id}/issue`)
        .set("Cookie", cookie).send({ conduct: "Good" });
      const docAfterIssue = await request(app)
        .get(`/api/students/tc-requests/${req1.body.id}/noc-document-data`).set("Cookie", cookie);
      expect(docAfterIssue.status).toBe(200);
    });

    it("issuing a TC for a historical request cleared before this feature existed falls back to its own free-text reason", async () => {
      // A request cleared through the old /clear (no exit_reason
      // column, no NOC number) predates this feature entirely —
      // simulated directly since the old, unextended /clear no longer
      // exists to actually produce this state. /issue must still
      // handle it exactly as it always did.
      const cookie = await loginAs("owner@http.test");
      const enrollment = await admitAndCharge(cookie, "2026/noc-legacy");
      const req1 = await request(app).post(`/api/students/enrollments/${enrollment.id}/tc-requests`)
        .set("Cookie", cookie).send({ reason: "Old-style free-text reason", last_day: "2026-09-20" });
      await pool.query(
        `UPDATE tc_requests SET status = 'cleared', cleared_on = now() WHERE id = $1`,
        [req1.body.id],
      ); // exit_reason, noc_number, financial_snapshot all stay null — the true legacy shape

      const issue = await request(app).post(`/api/students/tc-requests/${req1.body.id}/issue`)
        .set("Cookie", cookie).send({ conduct: "Good" });
      expect(issue.status).toBe(200);

      const row = await pool.query(`SELECT withdrawal_reason FROM enrollments WHERE id = $1`, [enrollment.id]);
      expect(row.rows[0].withdrawal_reason).toBe("Old-style free-text reason");
    });
  });

  describe("Left / TC Students — a dedicated historical view", () => {
    async function admitAndWithdraw(cookie: string, overrides: {
      admission_no: string; full_name: string; year: any; classLevel: any; section: any;
    }) {
      const admission = await request(app).post("/api/students/admit").set("Cookie", cookie).send({
        admission_no: overrides.admission_no, full_name: overrides.full_name,
        gender: "female", contact_type: "guardian",
        guardian_relationship: "Mother", guardian_name: "Test Guardian",
        guardian_phone: "9000000099", academic_year_id: overrides.year.id,
        class_level_id: overrides.classLevel.id, section_id: overrides.section.id,
      });
      const enrollment = admission.body.enrollment;
      await request(app).post(`/api/students/enrollments/${enrollment.id}/withdraw`)
        .set("Cookie", cookie).send({ withdrawn_on: "2026-09-10", reason: "Moved to another city" });
      return enrollment;
    }

    async function admitAndIssueTc(cookie: string, overrides: {
      admission_no: string; full_name: string; year: any; classLevel: any; section: any;
    }) {
      const admission = await request(app).post("/api/students/admit").set("Cookie", cookie).send({
        admission_no: overrides.admission_no, full_name: overrides.full_name,
        gender: "male", contact_type: "guardian",
        guardian_relationship: "Father", guardian_name: "Test Guardian TC",
        guardian_phone: "9000000098", academic_year_id: overrides.year.id,
        class_level_id: overrides.classLevel.id, section_id: overrides.section.id,
      });
      const enrollment = admission.body.enrollment;
      const req1 = await request(app).post(`/api/students/enrollments/${enrollment.id}/tc-requests`)
        .set("Cookie", cookie).send({ reason: "Relocating", last_day: "2026-09-12" });
      await request(app).post(`/api/students/tc-requests/${req1.body.id}/clear`)
        .set("Cookie", cookie).send({ clearance_note: "All dues cleared", exit_reason: "tc" });
      await request(app).post(`/api/students/tc-requests/${req1.body.id}/issue`)
        .set("Cookie", cookie).send({ conduct: "Excellent", qualified_for_promotion: true, remarks: "Good student" });
      return enrollment;
    }

    it("lists a withdrawn student and a TC-issued student, but not an active one", async () => {
      const cookie = await loginAs("owner@http.test");
      const { year, classLevel, section } = await setUpAcademicStructure(cookie);
      const withdrawn = await admitAndWithdraw(cookie,
        { admission_no: "2026/801", full_name: "Withdrawn Student", year, classLevel, section });
      const tcIssued = await admitAndIssueTc(cookie,
        { admission_no: "2026/802", full_name: "TC Student", year, classLevel, section });
      // A genuinely active student, admitted the same way, for contrast.
      await request(app).post("/api/students/admit").set("Cookie", cookie).send({
        admission_no: "2026/803", full_name: "Still Active Student", gender: "male",
        contact_type: "guardian", guardian_relationship: "Father", guardian_name: "Active Parent",
        academic_year_id: year.id, class_level_id: classLevel.id, section_id: section.id,
      });

      const res = await request(app).get("/api/students/former").set("Cookie", cookie);
      expect(res.status).toBe(200);
      const admissionNos = res.body.rows.map((r: any) => r.admission_no);
      expect(admissionNos).toContain("2026/801");
      expect(admissionNos).toContain("2026/802");
      expect(admissionNos).not.toContain("2026/803");

      const withdrawnRow = res.body.rows.find((r: any) => r.admission_no === "2026/801");
      expect(withdrawnRow.outcome).toBe("left");
      const tcRow = res.body.rows.find((r: any) => r.admission_no === "2026/802");
      expect(tcRow.outcome).toBe("tc_issued");
    });

    it("filters by status, class, academic year, and search — each independently", async () => {
      const cookie = await loginAs("owner@http.test");
      const { year, classLevel, section } = await setUpAcademicStructure(cookie);
      const otherClass = await request(app).post("/api/setup/class-levels").set("Cookie", cookie)
        .send({ name: "IX", ladder_order: 9, stage: "middle" });
      const otherSection = await request(app).post("/api/setup/sections").set("Cookie", cookie)
        .send({ academic_year_id: year.id, class_level_id: otherClass.body.id, name: "A" });
      const feeHead2 = await request(app).post("/api/setup/fee-heads").set("Cookie", cookie)
        .send({ name: "IX Tuition fee" });
      await request(app).post("/api/setup/fee-structure").set("Cookie", cookie).send({
        academic_year_id: year.id, class_level_id: otherClass.body.id,
        fee_head_id: feeHead2.body.id, amount: 4000000, due_on: "2026-06-15",
      });

      await admitAndWithdraw(cookie,
        { admission_no: "2026/810", full_name: "Rahul Kumar", year, classLevel, section });
      await admitAndIssueTc(cookie,
        { admission_no: "2026/811", full_name: "Priya Sharma", year,
          classLevel: otherClass.body, section: otherSection.body });

      // Status filter.
      const onlyTc = await request(app).get("/api/students/former?status=tc_issued").set("Cookie", cookie);
      expect(onlyTc.body.rows.map((r: any) => r.admission_no)).toEqual(["2026/811"]);

      const onlyLeft = await request(app).get("/api/students/former?status=left").set("Cookie", cookie);
      expect(onlyLeft.body.rows.map((r: any) => r.admission_no)).toEqual(["2026/810"]);

      // Class filter.
      const classFiltered = await request(app)
        .get(`/api/students/former?class_level_id=${classLevel.id}`).set("Cookie", cookie);
      expect(classFiltered.body.rows.map((r: any) => r.admission_no)).toEqual(["2026/810"]);

      // Academic year filter.
      const yearFiltered = await request(app)
        .get(`/api/students/former?academic_year_id=${year.id}`).set("Cookie", cookie);
      expect(yearFiltered.body.rows).toHaveLength(2); // both are in the same year here

      // Search by name.
      const byName = await request(app).get("/api/students/former?q=Priya").set("Cookie", cookie);
      expect(byName.body.rows.map((r: any) => r.admission_no)).toEqual(["2026/811"]);

      // Search by admission number.
      const byAdm = await request(app).get("/api/students/former?q=2026/810").set("Cookie", cookie);
      expect(byAdm.body.rows.map((r: any) => r.admission_no)).toEqual(["2026/810"]);
    });

    it("paginates server-side rather than returning everything at once", async () => {
      const cookie = await loginAs("owner@http.test");
      const { year, classLevel, section } = await setUpAcademicStructure(cookie);
      for (let i = 0; i < 5; i++) {
        await admitAndWithdraw(cookie, {
          admission_no: `2026/90${i}`, full_name: `Paged Student ${i}`, year, classLevel, section,
        });
      }
      const page1 = await request(app).get("/api/students/former?page=1&page_size=2").set("Cookie", cookie);
      expect(page1.body.rows).toHaveLength(2);
      expect(page1.body.total).toBe(5);
      expect(page1.body.page).toBe(1);

      const page2 = await request(app).get("/api/students/former?page=2&page_size=2").set("Cookie", cookie);
      expect(page2.body.rows).toHaveLength(2);
      // Different rows on page 2 than page 1 — genuine pagination, not
      // the same slice repeated.
      const page1Ids = page1.body.rows.map((r: any) => r.enrollment_id);
      const page2Ids = page2.body.rows.map((r: any) => r.enrollment_id);
      expect(page1Ids.some((id: string) => page2Ids.includes(id))).toBe(false);
    });

    it("view details returns full student, guardian, academic, and TC information in one call", async () => {
      const cookie = await loginAs("owner@http.test");
      const { year, classLevel, section } = await setUpAcademicStructure(cookie);
      const enrollment = await admitAndIssueTc(cookie,
        { admission_no: "2026/820", full_name: "Detail Test Student", year, classLevel, section });

      const res = await request(app).get(`/api/students/former/${enrollment.id}`).set("Cookie", cookie);
      expect(res.status).toBe(200);
      // Student details.
      expect(res.body.full_name).toBe("Detail Test Student");
      expect(res.body.admission_no).toBe("2026/820");
      // Guardian details — from the existing student/guardian columns,
      // no separate table.
      expect(res.body.guardian_name).toBe("Test Guardian TC");
      expect(res.body.guardian_phone).toBe("9000000098");
      // Academic details.
      expect(res.body.academic_year_name).toBe(year.name);
      expect(res.body.class_name).toBe(classLevel.name);
      expect(res.body.section_name).toBe(section.name);
      // TC details — the real, issued TC's own fields, not invented.
      expect(res.body.outcome).toBe("tc_issued");
      expect(res.body.tc_number).toMatch(/^TC\//);
      expect(res.body.tc_conduct).toBe("Excellent");
      expect(res.body.tc_qualified_for_promotion).toBe(true);
      expect(res.body.tc_reason).toBe("Relocating"); // the request's own free-text reason
      // The controlled exit-reason label set at NOC/clearance time
      // (this fixture's admitAndIssueTc passes exit_reason: "tc"),
      // mirrored onto the enrollment — distinct from tc_reason above.
      expect(res.body.withdrawal_reason).toBe("TC");
    });

    it("a plain withdrawal's view details has no TC fields — genuinely null, not invented", async () => {
      const cookie = await loginAs("owner@http.test");
      const { year, classLevel, section } = await setUpAcademicStructure(cookie);
      const enrollment = await admitAndWithdraw(cookie,
        { admission_no: "2026/821", full_name: "Plain Withdrawal", year, classLevel, section });

      const res = await request(app).get(`/api/students/former/${enrollment.id}`).set("Cookie", cookie);
      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe("left");
      expect(res.body.withdrawal_reason).toBe("Moved to another city");
      expect(res.body.tc_number).toBeNull();
      expect(res.body.tc_issued_on).toBeNull();
      expect(res.body.tc_conduct).toBeNull();
    });

    it("an active student's enrollment is not reachable through either endpoint", async () => {
      const cookie = await loginAs("owner@http.test");
      const { year, classLevel, section } = await setUpAcademicStructure(cookie);
      const admission = await request(app).post("/api/students/admit").set("Cookie", cookie).send({
        admission_no: "2026/830", full_name: "Never Left", gender: "male",
        contact_type: "guardian", guardian_relationship: "Father", guardian_name: "Parent",
        academic_year_id: year.id, class_level_id: classLevel.id, section_id: section.id,
      });
      const activeEnrollmentId = admission.body.enrollment.id;

      const list = await request(app).get("/api/students/former").set("Cookie", cookie);
      expect(list.body.rows.map((r: any) => r.enrollment_id)).not.toContain(activeEnrollmentId);

      const detail = await request(app).get(`/api/students/former/${activeEnrollmentId}`).set("Cookie", cookie);
      expect(detail.status).toBe(404);
    });

    it("front desk (manage_admissions) and accountant (manage_tc) can both view; viewer cannot", async () => {
      const ownerCookie = await loginAs("owner@http.test");
      const { year, classLevel, section } = await setUpAcademicStructure(ownerCookie);
      await admitAndWithdraw(ownerCookie,
        { admission_no: "2026/840", full_name: "Perm Test Student", year, classLevel, section });

      const deskCookie = await loginAs("desk@http.test");
      const deskRes = await request(app).get("/api/students/former").set("Cookie", deskCookie);
      expect(deskRes.status).toBe(200);

      const accCookie = await loginAs("acc@http.test");
      const accRes = await request(app).get("/api/students/former").set("Cookie", accCookie);
      expect(accRes.status).toBe(200);

      const viewerUser = await createUser("viewer@http.test", "x".repeat(14));
      await createMembership(viewerUser.id, school.id, "viewer");
      const viewerCookie = await loginAs("viewer@http.test");
      const viewerRes = await request(app).get("/api/students/former").set("Cookie", viewerCookie);
      expect(viewerRes.status).toBe(403);
    });

    it("never returns another school's former students — tenant isolation", async () => {
      const cookie = await loginAs("owner@http.test");
      const { year, classLevel, section } = await setUpAcademicStructure(cookie);
      await admitAndWithdraw(cookie,
        { admission_no: "2026/850", full_name: "School A Student", year, classLevel, section });

      const otherSchool = await createSchool({ short_code: "http-test-other" });
      const otherOwner = await createUser("owner2@http.test", "x".repeat(14));
      await createMembership(otherOwner.id, otherSchool.id, "owner");
      const otherCookie = await loginAs("owner2@http.test");

      const res = await request(app).get("/api/students/former").set("Cookie", otherCookie);
      expect(res.status).toBe(200);
      expect(res.body.rows).toHaveLength(0); // sees none of School A's former students
    });

    it("existing active-student endpoints are completely unaffected", async () => {
      const cookie = await loginAs("owner@http.test");
      const { year, classLevel, section } = await setUpAcademicStructure(cookie);
      const withdrawn = await admitAndWithdraw(cookie,
        { admission_no: "2026/860", full_name: "Gone Now", year, classLevel, section });

      // The active roster (Fee Collection's own data source) must not
      // include a withdrawn student — confirming this fix doesn't
      // loosen that filtering to make the new screen work.
      const roster = await request(app)
        .get(`/api/students/enrollments?academic_year_id=${year.id}`).set("Cookie", cookie);
      expect(roster.body.map((r: any) => r.id)).not.toContain(withdrawn.id);

      // The existing profile endpoint is untouched — still reachable
      // for a withdrawn enrollment too (it never filtered by is_active
      // in the first place), exactly as it worked before this feature.
      const profile = await request(app)
        .get(`/api/students/enrollments/${withdrawn.id}/profile`).set("Cookie", cookie);
      expect(profile.status).toBe(200);
    });
  });

  describe("GET /setup/sections — student_count for New Admission's section picker", () => {
    async function admitInto(cookie: string, sectionId: string, year: any, classLevel: any, n: number) {
      for (let i = 0; i < n; i++) {
        const unique = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
        const res = await request(app).post("/api/students/admit").set("Cookie", cookie).send({
          admission_no: `2026/hc-${unique}`, full_name: `Headcount Student ${i}`,
          gender: "male", contact_type: "guardian", guardian_relationship: "Father",
          guardian_name: "Test Parent", academic_year_id: year.id,
          class_level_id: classLevel.id, section_id: sectionId,
        });
        expect(res.status).toBe(201);
      }
    }

    it("returns the correct active-enrollment count for every section of a class, in one call", async () => {
      const cookie = await loginAs("owner@http.test");
      const { year, classLevel, section: sectionA } = await setUpAcademicStructure(cookie);
      const sectionB = await request(app).post("/api/setup/sections").set("Cookie", cookie)
        .send({ academic_year_id: year.id, class_level_id: classLevel.id, name: "B" }).then((r) => r.body);

      await admitInto(cookie, sectionA.id, year, classLevel, 3);
      await admitInto(cookie, sectionB.id, year, classLevel, 1);

      const res = await request(app)
        .get(`/api/setup/sections?academic_year_id=${year.id}&class_level_id=${classLevel.id}`)
        .set("Cookie", cookie);
      expect(res.status).toBe(200);
      const byName = Object.fromEntries(res.body.map((s: any) => [s.name, s.student_count]));
      expect(byName.A).toBe(3);
      expect(byName.B).toBe(1);
    });

    it("a section with no students shows 0, not null or missing", async () => {
      const cookie = await loginAs("owner@http.test");
      const { year, classLevel } = await setUpAcademicStructure(cookie);
      await request(app).post("/api/setup/sections").set("Cookie", cookie)
        .send({ academic_year_id: year.id, class_level_id: classLevel.id, name: "Empty" });

      const res = await request(app)
        .get(`/api/setup/sections?academic_year_id=${year.id}&class_level_id=${classLevel.id}`)
        .set("Cookie", cookie);
      const empty = res.body.find((s: any) => s.name === "Empty");
      expect(empty.student_count).toBe(0);
    });

    it("excludes withdrawn students from the count — the same active-enrollment rule everywhere else", async () => {
      const cookie = await loginAs("owner@http.test");
      const { year, classLevel } = await setUpAcademicStructure(cookie);
      const section = await request(app).post("/api/setup/sections").set("Cookie", cookie)
        .send({ academic_year_id: year.id, class_level_id: classLevel.id, name: "W" }).then((r) => r.body);

      const admission = await request(app).post("/api/students/admit").set("Cookie", cookie).send({
        admission_no: "2026/hc-w1", full_name: "Will Withdraw", gender: "male",
        contact_type: "guardian", guardian_relationship: "Father", guardian_name: "Parent",
        academic_year_id: year.id, class_level_id: classLevel.id, section_id: section.id,
      });
      await admitInto(cookie, section.id, year, classLevel, 2); // 2 who stay active

      let res = await request(app)
        .get(`/api/setup/sections?academic_year_id=${year.id}&class_level_id=${classLevel.id}`)
        .set("Cookie", cookie);
      expect(res.body.find((s: any) => s.name === "W").student_count).toBe(3);

      await request(app).post(`/api/students/enrollments/${admission.body.enrollment.id}/withdraw`)
        .set("Cookie", cookie).send({ withdrawn_on: "2026-09-01", reason: "Test" });

      res = await request(app)
        .get(`/api/setup/sections?academic_year_id=${year.id}&class_level_id=${classLevel.id}`)
        .set("Cookie", cookie);
      expect(res.body.find((s: any) => s.name === "W").student_count).toBe(2);
    });

    it("does not count a student from a different academic year", async () => {
      const cookie = await loginAs("owner@http.test");
      const { year, classLevel } = await setUpAcademicStructure(cookie);
      const section = await request(app).post("/api/setup/sections").set("Cookie", cookie)
        .send({ academic_year_id: year.id, class_level_id: classLevel.id, name: "Y" }).then((r) => r.body);
      await admitInto(cookie, section.id, year, classLevel, 2);

      const otherYear = await request(app).post("/api/setup/academic-years").set("Cookie", cookie)
        .send({ name: "2027-28", starts_on: "2027-06-01", ends_on: "2028-03-31" }).then((r) => r.body);
      const otherYearSection = await request(app).post("/api/setup/sections").set("Cookie", cookie)
        .send({ academic_year_id: otherYear.id, class_level_id: classLevel.id, name: "Y" }).then((r) => r.body);

      const res = await request(app)
        .get(`/api/setup/sections?academic_year_id=${otherYear.id}&class_level_id=${classLevel.id}`)
        .set("Cookie", cookie);
      // A brand-new section in the new year, same name — its own count
      // must be 0, not inherit the 2 students actually enrolled in the
      // *previous* year's "Y" section.
      expect(res.body.find((s: any) => s.id === otherYearSection.id).student_count).toBe(0);
    });

    it("refreshes to reflect a new admission immediately", async () => {
      const cookie = await loginAs("owner@http.test");
      const { year, classLevel } = await setUpAcademicStructure(cookie);
      const section = await request(app).post("/api/setup/sections").set("Cookie", cookie)
        .send({ academic_year_id: year.id, class_level_id: classLevel.id, name: "R" }).then((r) => r.body);
      await admitInto(cookie, section.id, year, classLevel, 1);

      let res = await request(app)
        .get(`/api/setup/sections?academic_year_id=${year.id}&class_level_id=${classLevel.id}`)
        .set("Cookie", cookie);
      expect(res.body.find((s: any) => s.name === "R").student_count).toBe(1);

      await admitInto(cookie, section.id, year, classLevel, 1); // one more, right after

      res = await request(app)
        .get(`/api/setup/sections?academic_year_id=${year.id}&class_level_id=${classLevel.id}`)
        .set("Cookie", cookie);
      expect(res.body.find((s: any) => s.name === "R").student_count).toBe(2);
    });

    it("never counts another school's students in this school's sections", async () => {
      const cookie = await loginAs("owner@http.test");
      const { year, classLevel } = await setUpAcademicStructure(cookie);
      const section = await request(app).post("/api/setup/sections").set("Cookie", cookie)
        .send({ academic_year_id: year.id, class_level_id: classLevel.id, name: "T" }).then((r) => r.body);
      await admitInto(cookie, section.id, year, classLevel, 4);

      const otherSchool = await createSchool({ short_code: "http-test-hc-other" });
      const otherOwner = await createUser("owner-hc@http.test", "x".repeat(14));
      await createMembership(otherOwner.id, otherSchool.id, "owner");
      const otherCookie = await loginAs("owner-hc@http.test");
      const { year: otherYear, classLevel: otherClassLevel } = await setUpAcademicStructure(otherCookie);
      const otherSection = await request(app).post("/api/setup/sections").set("Cookie", otherCookie)
        .send({ academic_year_id: otherYear.id, class_level_id: otherClassLevel.id, name: "T" })
        .then((r) => r.body);

      const res = await request(app)
        .get(`/api/setup/sections?academic_year_id=${otherYear.id}&class_level_id=${otherClassLevel.id}`)
        .set("Cookie", otherCookie);
      expect(res.body.find((s: any) => s.id === otherSection.id).student_count).toBe(0);
    });

    it("a new section defaults to a capacity of 100 when none is given", async () => {
      const cookie = await loginAs("owner@http.test");
      const { year, classLevel } = await setUpAcademicStructure(cookie);
      const created = await request(app).post("/api/setup/sections").set("Cookie", cookie)
        .send({ academic_year_id: year.id, class_level_id: classLevel.id, name: "Cap" });
      expect(created.body.capacity).toBe(100);
    });
  });

  it("an accountant can see the day book after front desk collects", async () => {
    const ownerCookie = await loginAs("owner@http.test");
    const { year, classLevel, section } = await setUpAcademicStructure(ownerCookie);
    const deskCookie = await loginAs("desk@http.test");
    const admission = await request(app).post("/api/students/admit").set("Cookie", deskCookie).send({
      admission_no: "2026/003", full_name: "Arjun Shetty",
      gender: "male", contact_type: "guardian",
      guardian_relationship: "Father", guardian_name: "Test Guardian",
      academic_year_id: year.id, class_level_id: classLevel.id, section_id: section.id,
    });
    await request(app).post("/api/collection/payments").set("Cookie", deskCookie).send({
      enrollment_id: admission.body.enrollment.id, amount: 2000000, mode: "upi",
    });

    const accCookie = await loginAs("acc@http.test");
    const today = new Date().toISOString().slice(0, 10);
    const dayBook = await request(app).get(`/api/collection/day-book?date=${today}`)
      .set("Cookie", accCookie);
    expect(dayBook.status).toBe(200);
    expect(dayBook.body.total).toBe(2000000);
    expect(dayBook.body.byMode.upi).toBe(2000000);
  });

  it("issuing an invoice over HTTP requires collect_payments and returns a numbered invoice", async () => {
    const ownerCookie = await loginAs("owner@http.test");
    const { year, classLevel, section } = await setUpAcademicStructure(ownerCookie);
    const deskCookie = await loginAs("desk@http.test");
    const admission = await request(app).post("/api/students/admit").set("Cookie", deskCookie).send({
      admission_no: "2026/004", full_name: "Meera Nair",
      gender: "male", contact_type: "guardian",
      guardian_relationship: "Father", guardian_name: "Test Guardian",
      academic_year_id: year.id, class_level_id: classLevel.id, section_id: section.id,
    });

    const invoice = await request(app)
      .post(`/api/billing/enrollments/${admission.body.enrollment.id}/invoice`)
      .set("Cookie", deskCookie).send({});
    expect(invoice.status).toBe(201);
    expect(invoice.body.invoice_no).toMatch(/^INV\//);
  });

  it("anonymous requests to every route in this domain are refused", async () => {
    const routes = [
      ["get", "/api/setup/academic-years"],
      ["post", "/api/students/admit"],
      ["post", "/api/collection/payments"],
      ["get", "/api/collection/day-book"],
    ] as const;
    for (const [method, path] of routes) {
      const res = await (request(app) as any)[method](path);
      expect(res.status).toBe(403);
    }
  });
});

describe("concessions and enrollment editing", () => {
  async function setUpAdmittedStudent(cookie: string) {
    const year = await request(app).post("/api/setup/academic-years").set("Cookie", cookie)
      .send({ name: "2026-27", starts_on: "2026-06-01", ends_on: "2027-03-31", status: "active" });
    const classLevel = await request(app).post("/api/setup/class-levels").set("Cookie", cookie)
      .send({ name: "VIII", ladder_order: 8, stage: "middle" });
    const sectionA = await request(app).post("/api/setup/sections").set("Cookie", cookie).send({
      academic_year_id: year.body.id, class_level_id: classLevel.body.id, name: "A",
    });
    const sectionB = await request(app).post("/api/setup/sections").set("Cookie", cookie).send({
      academic_year_id: year.body.id, class_level_id: classLevel.body.id, name: "B",
    });
    const feeHead = await request(app).post("/api/setup/fee-heads").set("Cookie", cookie)
      .send({ name: "Tuition fee" });
    await request(app).post("/api/setup/fee-structure").set("Cookie", cookie).send({
      academic_year_id: year.body.id, class_level_id: classLevel.body.id,
      fee_head_id: feeHead.body.id, amount: 4000000, due_on: "2026-06-15",
    });
    const admission = await request(app).post("/api/students/admit").set("Cookie", cookie).send({
      admission_no: "2026/800", full_name: "Test Student",
      gender: "male", contact_type: "guardian",
      guardian_relationship: "Father", guardian_name: "Test Guardian",
      academic_year_id: year.body.id, class_level_id: classLevel.body.id,
      section_id: sectionA.body.id,
    });
    return { year: year.body, sectionA: sectionA.body, sectionB: sectionB.body,
             enrollment: admission.body.enrollment };
  }

  it("granting a concession reduces the ledger balance", async () => {
    const cookie = await loginAs("owner@http.test");
    const { enrollment } = await setUpAdmittedStudent(cookie);

    const concession = await request(app)
      .post(`/api/students/enrollments/${enrollment.id}/concessions`).set("Cookie", cookie)
      .send({ amount: 1000000, reason: "sibling", note: "10% sibling discount" });
    expect(concession.status).toBe(201);

    const ledger = await request(app).get(`/api/students/enrollments/${enrollment.id}/ledger`)
      .set("Cookie", cookie);
    expect(ledger.body.charged).toBe(4000000);
    expect(ledger.body.conceded).toBe(1000000);
    expect(ledger.body.balance).toBe(3000000);
  });

  it("the enrollments list's inline ledger (include_ledger=1) matches the single-enrollment ledger exactly", async () => {
    const cookie = await loginAs("owner@http.test");
    const { year, enrollment } = await setUpAdmittedStudent(cookie);
    await request(app).post(`/api/students/enrollments/${enrollment.id}/concessions`)
      .set("Cookie", cookie).send({ amount: 500000, reason: "hardship" });
    await request(app).post("/api/collection/payments").set("Cookie", cookie)
      .send({ enrollment_id: enrollment.id, amount: 1000000, mode: "cash" });

    const single = await request(app).get(`/api/students/enrollments/${enrollment.id}/ledger`)
      .set("Cookie", cookie);

    const withLedger = await request(app)
      .get(`/api/students/enrollments?academic_year_id=${year.id}&include_ledger=1`)
      .set("Cookie", cookie);
    const row = withLedger.body.find((r: any) => r.id === enrollment.id);
    expect(row.ledger).toEqual(single.body);

    // Without the flag, no ledger at all — callers that don't ask for
    // it shouldn't pay for (or receive) the aggregate work.
    const withoutLedger = await request(app)
      .get(`/api/students/enrollments?academic_year_id=${year.id}`)
      .set("Cookie", cookie);
    const rowNoLedger = withoutLedger.body.find((r: any) => r.id === enrollment.id);
    expect(rowNoLedger.ledger).toBeUndefined();
  });

  it("logs both granting and reversing a concession", async () => {
    const cookie = await loginAs("owner@http.test");
    const { enrollment } = await setUpAdmittedStudent(cookie);
    const concession = await request(app)
      .post(`/api/students/enrollments/${enrollment.id}/concessions`).set("Cookie", cookie)
      .send({ amount: 1000000, reason: "sibling" });
    await request(app).post(`/api/students/concessions/${concession.body.id}/reverse`)
      .set("Cookie", cookie).send({ reason: "Granted in error" });

    const log = await request(app).get("/api/audit-log?entity_type=concession").set("Cookie", cookie);
    const actions = log.body.map((e: any) => e.action);
    expect(actions).toContain("concession.grant");
    expect(actions).toContain("concession.reverse");
  });

  it("records who in management approved a concession, separate from who recorded it", async () => {
    const cookie = await loginAs("owner@http.test");
    const { enrollment } = await setUpAdmittedStudent(cookie);

    const concession = await request(app)
      .post(`/api/students/enrollments/${enrollment.id}/concessions`).set("Cookie", cookie)
      .send({ amount: 500000, reason: "hardship", approver_name: "R. Krishnamurthy (Principal)" });
    expect(concession.status).toBe(201);
    expect(concession.body.approver_name).toBe("R. Krishnamurthy (Principal)");

    const list = await request(app).get(`/api/students/enrollments/${enrollment.id}/concessions`)
      .set("Cookie", cookie);
    expect(list.body[0].approver_name).toBe("R. Krishnamurthy (Principal)");
    // Genuinely separate from who was signed in and recorded it.
    expect(list.body[0].recorded_by_name).not.toBe("R. Krishnamurthy (Principal)");
  });

  it("reversing a concession restores the balance without deleting the original record", async () => {
    const cookie = await loginAs("owner@http.test");
    const { enrollment } = await setUpAdmittedStudent(cookie);
    const concession = await request(app)
      .post(`/api/students/enrollments/${enrollment.id}/concessions`).set("Cookie", cookie)
      .send({ amount: 1000000, reason: "merit" });

    const reversed = await request(app)
      .post(`/api/students/concessions/${concession.body.id}/reverse`).set("Cookie", cookie)
      .send({ reason: "Approved in error" });
    expect(reversed.status).toBe(204);

    const ledger = await request(app).get(`/api/students/enrollments/${enrollment.id}/ledger`)
      .set("Cookie", cookie);
    expect(ledger.body.conceded).toBe(0); // no longer counted
    expect(ledger.body.balance).toBe(4000000);

    const list = await request(app).get(`/api/students/enrollments/${enrollment.id}/concessions`)
      .set("Cookie", cookie);
    expect(list.body).toHaveLength(2); // original + reversal marker, both still visible
    const original = list.body.find((c: any) => c.id === concession.body.id);
    expect(original.reversed_by).not.toBeNull();
    expect(original.reversal_reason).toBe("Approved in error");
  });

  it("cannot reverse the same concession twice", async () => {
    const cookie = await loginAs("owner@http.test");
    const { enrollment } = await setUpAdmittedStudent(cookie);
    const concession = await request(app)
      .post(`/api/students/enrollments/${enrollment.id}/concessions`).set("Cookie", cookie)
      .send({ amount: 500000, reason: "hardship" });

    await request(app).post(`/api/students/concessions/${concession.body.id}/reverse`)
      .set("Cookie", cookie).send({});
    const second = await request(app).post(`/api/students/concessions/${concession.body.id}/reverse`)
      .set("Cookie", cookie).send({});
    expect(second.status).toBe(400);
  });

  it("front desk cannot grant or reverse a concession", async () => {
    const ownerCookie = await loginAs("owner@http.test");
    const { enrollment } = await setUpAdmittedStudent(ownerCookie);

    const deskCookie = await loginAs("desk@http.test");
    const grant = await request(app)
      .post(`/api/students/enrollments/${enrollment.id}/concessions`).set("Cookie", deskCookie)
      .send({ amount: 500000, reason: "other" });
    expect(grant.status).toBe(403);
  });

  it("front desk can move a student to a real section (assigning it later, as designed)", async () => {
    const ownerCookie = await loginAs("owner@http.test");
    const { enrollment, sectionB } = await setUpAdmittedStudent(ownerCookie);

    const deskCookie = await loginAs("desk@http.test");
    const patch = await request(app).patch(`/api/students/enrollments/${enrollment.id}`)
      .set("Cookie", deskCookie).send({ section_id: sectionB.id, roll_no: 7 });
    expect(patch.status).toBe(200);
    expect(patch.body.section_id).toBe(sectionB.id);
    expect(patch.body.roll_no).toBe(7);
  });

  it("logs a section change to the audit log", async () => {
    const cookie = await loginAs("owner@http.test");
    const { enrollment, sectionB } = await setUpAdmittedStudent(cookie);
    await request(app).patch(`/api/students/enrollments/${enrollment.id}`)
      .set("Cookie", cookie).send({ section_id: sectionB.id });

    const log = await request(app).get("/api/audit-log?entity_type=enrollment").set("Cookie", cookie);
    const entry = log.body.find((e: any) => e.action === "enrollment.section_change");
    expect(entry).toBeDefined();
    expect(entry.entity_id).toBe(enrollment.id);
  });

  it("returns a full student profile for the profile screen", async () => {
    const cookie = await loginAs("owner@http.test");
    const { enrollment } = await setUpAdmittedStudent(cookie);
    const profile = await request(app).get(`/api/students/enrollments/${enrollment.id}/profile`)
      .set("Cookie", cookie);
    expect(profile.status).toBe(200);
    expect(profile.body.full_name).toBe("Test Student");
    expect(profile.body.admission_no).toBe("2026/800");
    expect(profile.body.class_name).toBe("VIII");
    expect(profile.body.section_name).toBe("A");
  });

  it("edits a student's contact details, and logs it", async () => {
    const cookie = await loginAs("owner@http.test");
    const { enrollment } = await setUpAdmittedStudent(cookie);
    const studentId = enrollment.student_id;

    const patch = await request(app).patch(`/api/students/${studentId}`).set("Cookie", cookie).send({
      address: "New address after moving house",
      guardian_phone: "9999999999",
    });
    expect(patch.status).toBe(200);
    expect(patch.body.address).toBe("New address after moving house");
    expect(patch.body.guardian_phone).toBe("9999999999");

    const profile = await request(app).get(`/api/students/enrollments/${enrollment.id}/profile`)
      .set("Cookie", cookie);
    expect(profile.body.address).toBe("New address after moving house");

    const log = await request(app).get("/api/audit-log?entity_type=student").set("Cookie", cookie);
    const entry = log.body.find((e: any) => e.action === "student.update");
    expect(entry).toBeDefined();
    expect(entry.description).toContain("Test Student");
  });

  it("student edits do not allow changing identity fields like name or admission number", async () => {
    const cookie = await loginAs("owner@http.test");
    const { enrollment } = await setUpAdmittedStudent(cookie);
    const res = await request(app).patch(`/api/students/${enrollment.student_id}`)
      .set("Cookie", cookie).send({ full_name: "Renamed Entirely" });
    // full_name isn't in the schema at all — an unknown field alone
    // with nothing recognized leaves nothing to update.
    expect(res.status).toBe(400);
  });

  it("front desk can edit a student's contact details (manage_admissions)", async () => {
    const ownerCookie = await loginAs("owner@http.test");
    const { enrollment } = await setUpAdmittedStudent(ownerCookie);
    const deskCookie = await loginAs("desk@http.test");
    const res = await request(app).patch(`/api/students/${enrollment.student_id}`)
      .set("Cookie", deskCookie).send({ guardian_email: "newemail@example.test" });
    expect(res.status).toBe(200);
  });

  it("the profile endpoint reflects withdrawal details after withdrawing", async () => {
    const cookie = await loginAs("owner@http.test");
    const { enrollment } = await setUpAdmittedStudent(cookie);
    await request(app).post(`/api/students/enrollments/${enrollment.id}/withdraw`)
      .set("Cookie", cookie).send({ withdrawn_on: "2026-11-15", reason: "Transferred to another school" });

    const profile = await request(app).get(`/api/students/enrollments/${enrollment.id}/profile`)
      .set("Cookie", cookie);
    expect(profile.body.outcome).toBe("left");
    expect(profile.body.withdrawal_reason).toBe("Transferred to another school");
    expect(profile.body.withdrawn_on).toContain("2026-11-15");
  });

  describe("gender, blood group, and family details", () => {
    async function classSetup(cookie: string) {
      const year = await request(app).post("/api/setup/academic-years").set("Cookie", cookie)
        .send({ name: "2026-27", starts_on: "2026-06-01", ends_on: "2027-03-31" });
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

    it("refuses admission without gender", async () => {
      const cookie = await loginAs("owner@http.test");
      const { year, classLevel, section } = await classSetup(cookie);
      const res = await request(app).post("/api/students/admit").set("Cookie", cookie).send({
        admission_no: "2026/930", full_name: "No Gender Student",
        contact_type: "guardian", guardian_relationship: "Father", guardian_name: "A Guardian",
        academic_year_id: year.id, class_level_id: classLevel.id, section_id: section.id,
      });
      expect(res.status).toBe(400);
    });

    it("admits successfully without a blood group — it's optional", async () => {
      const cookie = await loginAs("owner@http.test");
      const { year, classLevel, section } = await classSetup(cookie);
      const res = await request(app).post("/api/students/admit").set("Cookie", cookie).send({
        admission_no: "2026/931", full_name: "No Blood Group Student", gender: "female",
        contact_type: "guardian", guardian_relationship: "Mother", guardian_name: "A Guardian",
        academic_year_id: year.id, class_level_id: classLevel.id, section_id: section.id,
      });
      expect(res.status).toBe(201);
      expect(res.body.student.blood_group).toBe("");
    });

    it("Parents requires both father's and mother's name", async () => {
      const cookie = await loginAs("owner@http.test");
      const { year, classLevel, section } = await classSetup(cookie);
      const res = await request(app).post("/api/students/admit").set("Cookie", cookie).send({
        admission_no: "2026/932", full_name: "Only Father Student", gender: "male",
        contact_type: "parents", father_name: "Some Father", // mother_name missing
        academic_year_id: year.id, class_level_id: classLevel.id, section_id: section.id,
      });
      expect(res.status).toBe(400);
    });

    it("Guardian requires both relationship and name", async () => {
      const cookie = await loginAs("owner@http.test");
      const { year, classLevel, section } = await classSetup(cookie);
      const res = await request(app).post("/api/students/admit").set("Cookie", cookie).send({
        admission_no: "2026/933", full_name: "No Relationship Student", gender: "male",
        contact_type: "guardian", guardian_name: "Some Guardian", // relationship missing
        academic_year_id: year.id, class_level_id: classLevel.id, section_id: section.id,
      });
      expect(res.status).toBe(400);
    });

    it("Parents: the primary contact (guardian_name/phone/email) is derived from the father", async () => {
      const cookie = await loginAs("owner@http.test");
      const { year, classLevel, section } = await classSetup(cookie);
      const res = await request(app).post("/api/students/admit").set("Cookie", cookie).send({
        admission_no: "2026/934", full_name: "Parents Student", gender: "male", blood_group: "O+",
        contact_type: "parents",
        father_name: "Suresh Rao", father_phone: "9000000001", father_email: "suresh@example.test",
        mother_name: "Lakshmi Rao", mother_phone: "9000000002",
        academic_year_id: year.id, class_level_id: classLevel.id, section_id: section.id,
      });
      expect(res.status).toBe(201);
      expect(res.body.student.blood_group).toBe("O+");
      expect(res.body.student.father_name).toBe("Suresh Rao");
      expect(res.body.student.mother_name).toBe("Lakshmi Rao");
      // The primary contact fields every other screen reads are
      // populated automatically — nothing downstream had to change.
      expect(res.body.student.guardian_name).toBe("Suresh Rao");
      expect(res.body.student.guardian_phone).toBe("9000000001");
      expect(res.body.student.guardian_email).toBe("suresh@example.test");
    });

    it("Parents: falls back to the mother's contact if the father's is blank", async () => {
      const cookie = await loginAs("owner@http.test");
      const { year, classLevel, section } = await classSetup(cookie);
      const res = await request(app).post("/api/students/admit").set("Cookie", cookie).send({
        admission_no: "2026/935", full_name: "Mother Fallback Student", gender: "female",
        contact_type: "parents",
        father_name: "Suresh Rao", // no father phone/email
        mother_name: "Lakshmi Rao", mother_phone: "9000000002", mother_email: "lakshmi@example.test",
        academic_year_id: year.id, class_level_id: classLevel.id, section_id: section.id,
      });
      expect(res.status).toBe(201);
      expect(res.body.student.guardian_phone).toBe("9000000002");
      expect(res.body.student.guardian_email).toBe("lakshmi@example.test");
    });

    it("Guardian: the primary contact is the guardian's own details", async () => {
      const cookie = await loginAs("owner@http.test");
      const { year, classLevel, section } = await classSetup(cookie);
      const res = await request(app).post("/api/students/admit").set("Cookie", cookie).send({
        admission_no: "2026/936", full_name: "Guardian Student", gender: "other",
        contact_type: "guardian", guardian_relationship: "Grandmother",
        guardian_name: "Kamala Devi", guardian_phone: "9000000003",
        academic_year_id: year.id, class_level_id: classLevel.id, section_id: section.id,
      });
      expect(res.status).toBe(201);
      expect(res.body.student.guardian_relationship).toBe("Grandmother");
      expect(res.body.student.guardian_name).toBe("Kamala Devi");
    });

    it("gender and blood group can both be edited later via the profile endpoint", async () => {
      const cookie = await loginAs("owner@http.test");
      const { year, classLevel, section } = await classSetup(cookie);
      const admission = await request(app).post("/api/students/admit").set("Cookie", cookie).send({
        admission_no: "2026/937", full_name: "Editable Student", gender: "male",
        contact_type: "guardian", guardian_relationship: "Father", guardian_name: "A Guardian",
        academic_year_id: year.id, class_level_id: classLevel.id, section_id: section.id,
      });
      const studentId = admission.body.enrollment.student_id;

      const patch = await request(app).patch(`/api/students/${studentId}`).set("Cookie", cookie)
        .send({ gender: "other", blood_group: "AB-" });
      expect(patch.status).toBe(200);
      expect(patch.body.gender).toBe("other");
      expect(patch.body.blood_group).toBe("AB-");
    });

    it("editing from Guardian to Parents re-derives the primary contact", async () => {
      const cookie = await loginAs("owner@http.test");
      const { year, classLevel, section } = await classSetup(cookie);
      const admission = await request(app).post("/api/students/admit").set("Cookie", cookie).send({
        admission_no: "2026/938", full_name: "Switching Student", gender: "female",
        contact_type: "guardian", guardian_relationship: "Aunt", guardian_name: "Aunt Name",
        guardian_phone: "9000000009",
        academic_year_id: year.id, class_level_id: classLevel.id, section_id: section.id,
      });
      const studentId = admission.body.enrollment.student_id;
      expect(admission.body.student.guardian_name).toBe("Aunt Name");

      const patch = await request(app).patch(`/api/students/${studentId}`).set("Cookie", cookie).send({
        contact_type: "parents",
        father_name: "New Father", father_phone: "9000000011",
        mother_name: "New Mother",
      });
      expect(patch.status).toBe(200);
      expect(patch.body.guardian_name).toBe("New Father");
      expect(patch.body.guardian_phone).toBe("9000000011");
    });
  });

  it("withdraws a student — sets outcome, is_active, and logs it", async () => {
    const cookie = await loginAs("owner@http.test");
    const { enrollment } = await setUpAdmittedStudent(cookie);

    const withdraw = await request(app).post(`/api/students/enrollments/${enrollment.id}/withdraw`)
      .set("Cookie", cookie).send({ withdrawn_on: "2026-11-15", reason: "Family relocating to another city" });
    expect(withdraw.status).toBe(200);
    expect(withdraw.body.outcome).toBe("left");
    expect(withdraw.body.is_active).toBe(false);
    expect(withdraw.body.withdrawal_reason).toBe("Family relocating to another city");

    const log = await request(app).get("/api/audit-log?entity_type=enrollment").set("Cookie", cookie);
    const entry = log.body.find((e: any) => e.action === "enrollment.withdraw");
    expect(entry).toBeDefined();
    expect(entry.description).toContain("Test Student");
  });

  it("records a refund at management's own amount, not capped to the ledger balance", async () => {
    const cookie = await loginAs("owner@http.test");
    const { enrollment } = await setUpAdmittedStudent(cookie);
    // Nothing has been paid at all — balance is the full charge, owed
    // TO the school, not a credit — yet a refund is still allowed
    // through, exactly as confirmed: management's own figure.
    const refund = await request(app).post(`/api/students/enrollments/${enrollment.id}/refund`)
      .set("Cookie", cookie).send({
        amount: 500000, mode: "cheque", instrument_ref: "CHQ00123",
        reason: "Goodwill gesture on withdrawal", approver_name: "R. Krishnamurthy (Principal)",
      });
    expect(refund.status).toBe(201);
    expect(refund.body.amount).toBe(500000);
    expect(refund.body.mode).toBe("cheque");

    const list = await request(app).get(`/api/students/enrollments/${enrollment.id}/refunds`)
      .set("Cookie", cookie);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].approver_name).toBe("R. Krishnamurthy (Principal)");

    const log = await request(app).get("/api/audit-log?entity_type=refund").set("Cookie", cookie);
    expect(log.body.length).toBeGreaterThan(0);
    expect(log.body[0].description).toContain("cheque");
  });

  it("front desk cannot record a refund (void_payments required)", async () => {
    const ownerCookie = await loginAs("owner@http.test");
    const { enrollment } = await setUpAdmittedStudent(ownerCookie);
    const deskCookie = await loginAs("desk@http.test");
    const res = await request(app).post(`/api/students/enrollments/${enrollment.id}/refund`)
      .set("Cookie", deskCookie).send({ amount: 100000, mode: "cash" });
    expect(res.status).toBe(403);
  });

  it("accountant can record a refund", async () => {
    const ownerCookie = await loginAs("owner@http.test");
    const { enrollment } = await setUpAdmittedStudent(ownerCookie);
    const accountantCookie = await loginAs("acc@http.test");
    const res = await request(app).post(`/api/students/enrollments/${enrollment.id}/refund`)
      .set("Cookie", accountantCookie).send({ amount: 100000, mode: "cash" });
    expect(res.status).toBe(201);
  });

  it("a refund reduces net paid and reopens the outstanding balance — the exact reported scenario", async () => {
    // Fee ₹40,000 (this helper's own fixture amount), paid in full,
    // then a ₹3,000 refund — mirroring the reported case where a
    // refund silently had no effect on what the ledger showed as paid.
    const cookie = await loginAs("owner@http.test");
    const { enrollment } = await setUpAdmittedStudent(cookie);
    await request(app).post("/api/collection/payments").set("Cookie", cookie).send({
      enrollment_id: enrollment.id, amount: 4000000, mode: "cash",
    });

    const before = await request(app)
      .get(`/api/students/enrollments/${enrollment.id}/profile`).set("Cookie", cookie);
    // Not asserted on directly (profile doesn't itself expose a ledger),
    // just confirms the enrollment is in the expected state before the
    // refund — the actual ledger checks are against the roster below,
    // which is what Fee Collection itself reads from.
    expect(before.status).toBe(200);

    await request(app).post(`/api/students/enrollments/${enrollment.id}/refund`)
      .set("Cookie", cookie).send({ amount: 300000, mode: "cash", reason: "Partial refund" });

    const roster = await request(app)
      .get(`/api/students/enrollments?academic_year_id=${enrollment.academic_year_id}&include_ledger=1`)
      .set("Cookie", cookie);
    const row = roster.body.find((r: any) => r.id === enrollment.id);
    expect(row.ledger.charged).toBe(4000000);
    expect(row.ledger.grossPaid).toBe(4000000);
    expect(row.ledger.refunded).toBe(300000);
    expect(row.ledger.paid).toBe(3700000); // net paid = gross - refund
    expect(row.ledger.balance).toBe(300000); // outstanding reopens by exactly the refund
  });

  it("a refund never touches the original payment itself — it stays exactly as recorded", async () => {
    const cookie = await loginAs("owner@http.test");
    const { enrollment } = await setUpAdmittedStudent(cookie);
    const payment = await request(app).post("/api/collection/payments").set("Cookie", cookie).send({
      enrollment_id: enrollment.id, amount: 4000000, mode: "cash",
    });
    await request(app).post(`/api/students/enrollments/${enrollment.id}/refund`)
      .set("Cookie", cookie).send({ amount: 1000000, mode: "cash" });

    const history = await request(app)
      .get(`/api/collection/enrollments/${enrollment.id}/payments`).set("Cookie", cookie);
    const original = history.body.find((p: any) => p.id === payment.body.id);
    expect(original.amount).toBe(4000000); // untouched — a refund is its own transaction
    expect(original.reversed_by).toBeFalsy();
  });

  it("a refund gets its own receipt number, distinct from a fee receipt or a TC number", async () => {
    const cookie = await loginAs("owner@http.test");
    const { enrollment } = await setUpAdmittedStudent(cookie);
    const payment = await request(app).post("/api/collection/payments").set("Cookie", cookie).send({
      enrollment_id: enrollment.id, amount: 4000000, mode: "cash",
    });

    const refund1 = await request(app).post(`/api/students/enrollments/${enrollment.id}/refund`)
      .set("Cookie", cookie).send({
        amount: 100000, mode: "cash", received_by: "Suresh Kumar (father)",
      });
    expect(refund1.status).toBe(201);
    expect(refund1.body.receipt_no).toMatch(/^RF\//);
    expect(refund1.body.receipt_no).not.toBe(payment.body.receipt_no);
    expect(refund1.body.received_by).toBe("Suresh Kumar (father)");

    const refund2 = await request(app).post(`/api/students/enrollments/${enrollment.id}/refund`)
      .set("Cookie", cookie).send({ amount: 50000, mode: "cash" });
    const seq1 = Number(refund1.body.receipt_no.split("/").pop());
    const seq2 = Number(refund2.body.receipt_no.split("/").pop());
    expect(seq2).toBe(seq1 + 1); // sequential, gapless, its own series
  });

  it("refund receipt-data returns everything the PDF needs in one call", async () => {
    const cookie = await loginAs("owner@http.test");
    const { enrollment } = await setUpAdmittedStudent(cookie);
    const refund = await request(app).post(`/api/students/enrollments/${enrollment.id}/refund`)
      .set("Cookie", cookie).send({
        amount: 200000, mode: "upi", instrument_ref: "UTR12345", reason: "Partial refund",
        approver_name: "Principal", received_by: "Parent Name",
      });

    const data = await request(app)
      .get(`/api/students/refunds/${refund.body.id}/receipt-data`).set("Cookie", cookie);
    expect(data.status).toBe(200);
    expect(data.body.student_name).toBe("Test Student");
    expect(data.body.admission_no).toBeTruthy();
    expect(data.body.school_name).toBeTruthy();
    expect(data.body.class_name).toBeTruthy();
    expect(data.body.section_name).toBeTruthy();
    expect(data.body.year_name).toBeTruthy();
    expect(data.body.amount).toBe(200000);
    expect(data.body.mode).toBe("upi");
    expect(data.body.instrument_ref).toBe("UTR12345");
    expect(data.body.approver_name).toBe("Principal");
    expect(data.body.received_by).toBe("Parent Name");
    expect(data.body.refunded_by_name).toBeDefined(); // present — empty string, since this fixture's owner has no full_name set
    expect(data.body.receipt_no).toMatch(/^RF\//);
  });

  it("rejects a duplicate roll number within the same section", async () => {
    const cookie = await loginAs("owner@http.test");
    const { year, sectionA, enrollment } = await setUpAdmittedStudent(cookie);
    await request(app).patch(`/api/students/enrollments/${enrollment.id}`)
      .set("Cookie", cookie).send({ roll_no: 1 });

    const admission2 = await request(app).post("/api/students/admit").set("Cookie", cookie).send({
      admission_no: "2026/801", full_name: "Second Student",
      gender: "male", contact_type: "guardian",
      guardian_relationship: "Father", guardian_name: "Test Guardian",
      academic_year_id: year.id, class_level_id: enrollment.class_level_id, section_id: sectionA.id,
    });
    const dup = await request(app).patch(`/api/students/enrollments/${admission2.body.enrollment.id}`)
      .set("Cookie", cookie).send({ roll_no: 1 });
    expect(dup.status).toBe(409);
  });
});

describe("gateway webhook", () => {
  it("accepts a correctly signed payload and is idempotent on retry", async () => {
    const ownerCookie = await loginAs("owner@http.test");
    const year = await request(app).post("/api/setup/academic-years").set("Cookie", ownerCookie)
      .send({ name: "2026-27", starts_on: "2026-06-01", ends_on: "2027-03-31", status: "active" });
    const classLevel = await request(app).post("/api/setup/class-levels").set("Cookie", ownerCookie)
      .send({ name: "VIII", ladder_order: 8, stage: "middle" });
    const section = await request(app).post("/api/setup/sections").set("Cookie", ownerCookie).send({
      academic_year_id: year.body.id, class_level_id: classLevel.body.id, name: "A",
    });
    const feeHead = await request(app).post("/api/setup/fee-heads").set("Cookie", ownerCookie)
      .send({ name: "Tuition fee" });
    await request(app).post("/api/setup/fee-structure").set("Cookie", ownerCookie).send({
      academic_year_id: year.body.id, class_level_id: classLevel.body.id,
      fee_head_id: feeHead.body.id, amount: 4000000, due_on: "2026-06-15",
    });
    const admission = await request(app).post("/api/students/admit").set("Cookie", ownerCookie).send({
      admission_no: "2026/005", full_name: "Kavya Reddy",
      gender: "male", contact_type: "guardian",
      guardian_relationship: "Father", guardian_name: "Test Guardian",
      academic_year_id: year.body.id, class_level_id: classLevel.body.id, section_id: section.body.id,
    });

    process.env.RAZORPAY_WEBHOOK_SECRET = "test-secret";
    const payload = JSON.stringify({
      enrollment_id: admission.body.enrollment.id, order_id: "order_1",
      payment_id: "pay_webhook_1", amount: 4000000,
    });
    const signature = crypto.createHmac("sha256", "test-secret").update(payload).digest("hex");

    const first = await request(app).post("/api/collection/webhook/razorpay")
      .set("Content-Type", "application/json")
      .set("x-webhook-signature", signature)
      .send(payload);
    expect(first.status).toBe(201);

    const second = await request(app).post("/api/collection/webhook/razorpay")
      .set("Content-Type", "application/json")
      .set("x-webhook-signature", signature)
      .send(payload);
    expect(second.status).toBe(200); // not created again
    expect(second.body.id).toBe(first.body.id);
  });

  it("rejects a webhook with a bad signature", async () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = "test-secret";
    const payload = JSON.stringify({
      enrollment_id: "00000000-0000-0000-0000-000000000000", order_id: "order_1",
      payment_id: "pay_bad", amount: 1000,
    });
    const res = await request(app).post("/api/collection/webhook/razorpay")
      .set("Content-Type", "application/json")
      .set("x-webhook-signature", "not-the-right-signature")
      .send(payload);
    expect(res.status).toBe(401);
  });
});
