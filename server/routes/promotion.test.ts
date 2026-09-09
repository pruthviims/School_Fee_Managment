/**
 * The promotion workflow's actual round trip: preview from the server,
 * send the moves back (as JSON, exactly as a browser would), assign
 * sections, commit, and reverse — checking the contract at each hop
 * survives serialization, not just that the underlying service functions
 * work when called directly in-process (promotion.test.ts already
 * covers that).
 */

import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../app.js";
import { pool } from "../db/index.js";
import { createMembership, createSchool, createUser, resetDb } from "../tests/helpers.js";
import { resetFeeDomain } from "../tests/fixtures.js";

let school: any;
let owner: any;
let frontDesk: any;

beforeEach(async () => {
  await resetFeeDomain();
  await resetDb();

  school = await createSchool({ short_code: "promo-http-test" });
  owner = await createUser("owner@promo.test", "x".repeat(14));
  await createMembership(owner.id, school.id, "owner");
  frontDesk = await createUser("desk@promo.test", "x".repeat(14));
  await createMembership(frontDesk.id, school.id, "front_desk");
  void frontDesk;
});

afterAll(async () => {
  await pool.end();
});

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: "x".repeat(14) });
  return res.headers["set-cookie"];
}

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
  const admission = await request(app).post("/api/students/admit").set("Cookie", cookie).send({
    admission_no: "2025/900", full_name: "Test Student",
    academic_year_id: fromYear.body.id, class_level_id: classVIII.body.id,
    section_id: sectionVIII.body.id,
  });

  return { fromYear: fromYear.body, toYear: toYear.body, admission: admission.body };
}

describe("promotion workflow over HTTP", () => {
  it("refuses to commit into a target class with no fees priced for the year", async () => {
    const cookie = await loginAs("owner@promo.test");
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
    const feeHead = await request(app).post("/api/setup/fee-heads").set("Cookie", cookie)
      .send({ name: "Tuition fee" });
    await request(app).post("/api/setup/fee-structure").set("Cookie", cookie).send({
      academic_year_id: fromYear.body.id, class_level_id: classVIII.body.id,
      fee_head_id: feeHead.body.id, amount: 4000000, due_on: "2025-06-15",
    });
    // Deliberately no fee-structure line for classIX in toYear at all.
    await request(app).post("/api/students/admit").set("Cookie", cookie).send({
      admission_no: "2025/900", full_name: "Test Student",
      academic_year_id: fromYear.body.id, class_level_id: classVIII.body.id,
      section_id: sectionVIII.body.id,
    });

    const previewRes = await request(app).post("/api/promotion/preview").set("Cookie", cookie)
      .send({ from_year_id: fromYear.body.id, to_year_id: toYear.body.id });
    const assignRes = await request(app).post("/api/promotion/assign-sections").set("Cookie", cookie)
      .send({ to_year_id: toYear.body.id, moves: previewRes.body.moves });

    const commitRes = await request(app).post("/api/promotion/commit").set("Cookie", cookie).send({
      from_year_id: fromYear.body.id, to_year_id: toYear.body.id, moves: assignRes.body.moves,
    });
    expect(commitRes.status).toBe(400);

    const enrollments = await request(app)
      .get(`/api/students/enrollments?academic_year_id=${toYear.body.id}`).set("Cookie", cookie);
    expect(enrollments.body).toHaveLength(0); // nothing committed, not a half-promoted student
  });

  it("previews, assigns sections, and commits a promotion end to end", async () => {
    const cookie = await loginAs("owner@promo.test");
    const { fromYear, toYear } = await setUpTwoYearLadder(cookie);

    const previewRes = await request(app).post("/api/promotion/preview").set("Cookie", cookie)
      .send({ from_year_id: fromYear.id, to_year_id: toYear.id });
    expect(previewRes.status).toBe(200);
    expect(previewRes.body.moves).toHaveLength(1);
    expect(previewRes.body.summary.promotable).toBe(1);

    const assignRes = await request(app).post("/api/promotion/assign-sections").set("Cookie", cookie)
      .send({ to_year_id: toYear.id, moves: previewRes.body.moves });
    expect(assignRes.status).toBe(200);
    expect(assignRes.body.moves[0].toSectionId).not.toBeNull();

    const commitRes = await request(app).post("/api/promotion/commit").set("Cookie", cookie).send({
      from_year_id: fromYear.id, to_year_id: toYear.id, moves: assignRes.body.moves,
    });
    expect(commitRes.status).toBe(201);
    expect(commitRes.body.status).toBe("committed");

    const enrollments = await request(app)
      .get(`/api/students/enrollments?academic_year_id=${toYear.id}`).set("Cookie", cookie);
    expect(enrollments.body).toHaveLength(1);
    expect(enrollments.body[0].class_name).toBe("IX");
  });

  it("reverses a committed batch while the target year is still planning", async () => {
    const cookie = await loginAs("owner@promo.test");
    const { fromYear, toYear } = await setUpTwoYearLadder(cookie);

    const previewRes = await request(app).post("/api/promotion/preview").set("Cookie", cookie)
      .send({ from_year_id: fromYear.id, to_year_id: toYear.id });
    const assignRes = await request(app).post("/api/promotion/assign-sections").set("Cookie", cookie)
      .send({ to_year_id: toYear.id, moves: previewRes.body.moves });
    const commitRes = await request(app).post("/api/promotion/commit").set("Cookie", cookie).send({
      from_year_id: fromYear.id, to_year_id: toYear.id, moves: assignRes.body.moves,
    });

    const reverseRes = await request(app)
      .post(`/api/promotion/batches/${commitRes.body.id}/reverse`).set("Cookie", cookie);
    expect(reverseRes.status).toBe(200);
    expect(reverseRes.body.status).toBe("reversed");

    const enrollments = await request(app)
      .get(`/api/students/enrollments?academic_year_id=${toYear.id}`).set("Cookie", cookie);
    expect(enrollments.body).toHaveLength(0);
  });

  it("commit rejects a move sent back with no section assigned (never trusts the client)", async () => {
    const cookie = await loginAs("owner@promo.test");
    const { fromYear, toYear } = await setUpTwoYearLadder(cookie);

    const previewRes = await request(app).post("/api/promotion/preview").set("Cookie", cookie)
      .send({ from_year_id: fromYear.id, to_year_id: toYear.id });

    // Deliberately skip assign-sections and try to commit raw preview moves.
    const commitRes = await request(app).post("/api/promotion/commit").set("Cookie", cookie).send({
      from_year_id: fromYear.id, to_year_id: toYear.id, moves: previewRes.body.moves,
    });
    expect(commitRes.status).toBe(400);
  });

  it("front desk (has manage_admissions) can run the full workflow, viewer cannot", async () => {
    const ownerCookie = await loginAs("owner@promo.test");
    const { fromYear, toYear } = await setUpTwoYearLadder(ownerCookie);

    const deskCookie = await loginAs("desk@promo.test");
    const previewRes = await request(app).post("/api/promotion/preview").set("Cookie", deskCookie)
      .send({ from_year_id: fromYear.id, to_year_id: toYear.id });
    expect(previewRes.status).toBe(200); // front_desk's role includes manage_admissions

    const viewerUser = await createUser("viewer@promo.test", "x".repeat(14));
    await createMembership(viewerUser.id, school.id, "viewer");
    const viewerCookie = await loginAs("viewer@promo.test");
    const viewerPreview = await request(app).post("/api/promotion/preview").set("Cookie", viewerCookie)
      .send({ from_year_id: fromYear.id, to_year_id: toYear.id });
    expect(viewerPreview.status).toBe(403); // viewer's role has no manage_admissions
  });

  it("anonymous requests to the promotion routes are refused", async () => {
    const res = await request(app).post("/api/promotion/preview")
      .send({ from_year_id: "00000000-0000-0000-0000-000000000000",
               to_year_id: "00000000-0000-0000-0000-000000000000" });
    expect(res.status).toBe(403);
  });

  it("rejects a preview where the target year doesn't follow the source year", async () => {
    const cookie = await loginAs("owner@promo.test");
    const { fromYear, toYear } = await setUpTwoYearLadder(cookie);

    const res = await request(app).post("/api/promotion/preview").set("Cookie", cookie)
      .send({ from_year_id: toYear.id, to_year_id: fromYear.id }); // swapped
    expect(res.status).toBe(400);
  });
});
