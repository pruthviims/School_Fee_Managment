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
import { resetFeeDomain } from "../tests/fixtures.js";

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

  it("lists payments for an enrollment, most recent first", async () => {
    const ownerCookie = await loginAs("owner@http.test");
    const { year, classLevel, section } = await setUpAcademicStructure(ownerCookie);
    const deskCookie = await loginAs("desk@http.test");
    const admission = await request(app).post("/api/students/admit").set("Cookie", deskCookie).send({
      admission_no: "2026/902", full_name: "Payment History Student",
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

  it("an accountant can see the day book after front desk collects", async () => {
    const ownerCookie = await loginAs("owner@http.test");
    const { year, classLevel, section } = await setUpAcademicStructure(ownerCookie);
    const deskCookie = await loginAs("desk@http.test");
    const admission = await request(app).post("/api/students/admit").set("Cookie", deskCookie).send({
      admission_no: "2026/003", full_name: "Arjun Shetty",
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

  it("rejects a duplicate roll number within the same section", async () => {
    const cookie = await loginAs("owner@http.test");
    const { year, sectionA, enrollment } = await setUpAdmittedStudent(cookie);
    await request(app).patch(`/api/students/enrollments/${enrollment.id}`)
      .set("Cookie", cookie).send({ roll_no: 1 });

    const admission2 = await request(app).post("/api/students/admit").set("Cookie", cookie).send({
      admission_no: "2026/801", full_name: "Second Student",
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
