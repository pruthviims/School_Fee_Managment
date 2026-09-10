import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../app.js";
import { pool } from "../db/index.js";
import { createMembership, createSchool, createUser, resetDb } from "../tests/helpers.js";
import { resetFeeDomain } from "../tests/fixtures.js";

let school: any;
let owner: any;
let viewer: any;

beforeEach(async () => {
  await resetFeeDomain();
  await resetDb();

  school = await createSchool({ short_code: "receipt-http-test" });
  owner = await createUser("owner@receipt.test", "x".repeat(14));
  await createMembership(owner.id, school.id, "owner");
  viewer = await createUser("viewer@receipt.test", "x".repeat(14));
  await createMembership(viewer.id, school.id, "viewer");
});

afterAll(async () => {
  await pool.end();
});

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: "x".repeat(14) });
  return res.headers["set-cookie"];
}

async function setUpAndAdmit(cookie: string) {
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
  const admission = await request(app).post("/api/students/admit").set("Cookie", cookie).send({
    admission_no: "2026/700", full_name: "Kavya Reddy",
    gender: "male", contact_type: "guardian",
    guardian_relationship: "Father", guardian_name: "Test Guardian",
    academic_year_id: year.body.id, class_level_id: classLevel.body.id, section_id: section.body.id,
  });
  return admission.body;
}

describe("receipt and invoice data routes", () => {
  it("returns assembled receipt data a browser could hand straight to jsPDF", async () => {
    const cookie = await loginAs("owner@receipt.test");
    const { enrollment } = await setUpAndAdmit(cookie);

    const payment = await request(app).post("/api/collection/payments").set("Cookie", cookie).send({
      enrollment_id: enrollment.id, amount: 1500000, mode: "cash",
    });

    const data = await request(app).get(`/api/collection/payments/${payment.body.id}/receipt-data`)
      .set("Cookie", cookie);
    expect(data.status).toBe(200);
    expect(data.body.student.fullName).toBe("Kavya Reddy");
    expect(data.body.lines[0].name).toBe("Tuition fee");
    expect(data.body.totalDisplay).toBe("15,000.00");
    expect(data.body.totalWords).toContain("Fifteen thousand");
  });

  it("a viewer (any active member) can look up a receipt, not just collect_payments roles", async () => {
    const ownerCookie = await loginAs("owner@receipt.test");
    const { enrollment } = await setUpAndAdmit(ownerCookie);
    const payment = await request(app).post("/api/collection/payments").set("Cookie", ownerCookie).send({
      enrollment_id: enrollment.id, amount: 1500000, mode: "cash",
    });

    const viewerCookie = await loginAs("viewer@receipt.test");
    const data = await request(app).get(`/api/collection/payments/${payment.body.id}/receipt-data`)
      .set("Cookie", viewerCookie);
    expect(data.status).toBe(200);
  });

  it("404s for a payment that doesn't exist, not a 500", async () => {
    const cookie = await loginAs("owner@receipt.test");
    const res = await request(app)
      .get("/api/collection/payments/00000000-0000-0000-0000-000000000000/receipt-data")
      .set("Cookie", cookie);
    expect(res.status).toBe(404);
  });

  it("returns invoice data with the frozen student name and class", async () => {
    const cookie = await loginAs("owner@receipt.test");
    const { enrollment } = await setUpAndAdmit(cookie);
    const invoice = await request(app)
      .post(`/api/billing/enrollments/${enrollment.id}/invoice`).set("Cookie", cookie).send({});

    const data = await request(app).get(`/api/billing/invoices/${invoice.body.id}/receipt-data`)
      .set("Cookie", cookie);
    expect(data.status).toBe(200);
    expect(data.body.student.fullName).toBe("Kavya Reddy");
    expect(data.body.headingText).toBe("Fee bill");
    expect(data.body.totalPaise).toBe(4000000);
  });

  it("anonymous requests to both routes are refused", async () => {
    const receiptRes = await request(app)
      .get("/api/collection/payments/00000000-0000-0000-0000-000000000000/receipt-data");
    expect(receiptRes.status).toBe(403);
    const invoiceRes = await request(app)
      .get("/api/billing/invoices/00000000-0000-0000-0000-000000000000/receipt-data");
    expect(invoiceRes.status).toBe(403);
  });
});
