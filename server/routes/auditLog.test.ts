import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../app.js";
import { pool } from "../db/index.js";
import { createMembership, createSchool, createUser, resetDb } from "../tests/helpers.js";

let school: any;

beforeEach(async () => {
  await resetDb();
  school = await createSchool({ short_code: "audit-test" });
  const owner = await createUser("owner@audit.test", "x".repeat(14));
  await createMembership(owner.id, school.id, "owner");
  const accountant = await createUser("accountant@audit.test", "x".repeat(14));
  await createMembership(accountant.id, school.id, "accountant");
  const desk = await createUser("desk@audit.test", "x".repeat(14));
  await createMembership(desk.id, school.id, "front_desk");
});

afterAll(async () => {
  await pool.end();
});

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: "x".repeat(14) });
  return res.headers["set-cookie"];
}

async function setUpPricedClass(cookie: string) {
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

describe("audit log", () => {
  it("logs a real admission with the correct actor, role, and description", async () => {
    const cookie = await loginAs("owner@audit.test");
    const { year, classLevel, section } = await setUpPricedClass(cookie);

    await request(app).post("/api/students/admit").set("Cookie", cookie).send({
      admission_no: "2026/500", full_name: "Ravi Kumar",
      academic_year_id: year.id, class_level_id: classLevel.id, section_id: section.id,
    });

    const log = await request(app).get("/api/audit-log").set("Cookie", cookie);
    expect(log.status).toBe(200);
    const entry = log.body.find((e: any) => e.action === "student.admit");
    expect(entry).toBeDefined();
    expect(entry.user_name).toBe("owner@audit.test");
    expect(entry.user_role).toBe("owner");
    expect(entry.description).toContain("Ravi Kumar");
    expect(entry.description).toContain("2026/500");
    expect(entry.entity_type).toBe("student");
  });

  it("logs staff invite, role change, and revoke, each with a real actor", async () => {
    const ownerCookie = await loginAs("owner@audit.test");
    const invite = await request(app).post("/api/staff").set("Cookie", ownerCookie)
      .send({ email: "newperson@audit.test", role: "front_desk" });

    await request(app).patch(`/api/staff/${invite.body.id}`).set("Cookie", ownerCookie)
      .send({ role: "accountant" });
    await request(app).delete(`/api/staff/${invite.body.id}`).set("Cookie", ownerCookie);

    const log = await request(app).get("/api/audit-log?entity_type=membership").set("Cookie", ownerCookie);
    const actions = log.body.map((e: any) => e.action);
    expect(actions).toContain("staff.invite");
    expect(actions).toContain("staff.update");
    expect(actions).toContain("staff.revoke");
    expect(log.body.every((e: any) => e.user_name === "owner@audit.test")).toBe(true);
  });

  it("front desk cannot view the audit log (view_audit_log required)", async () => {
    const cookie = await loginAs("desk@audit.test");
    const res = await request(app).get("/api/audit-log").set("Cookie", cookie);
    expect(res.status).toBe(403);
  });

  it("accountant can view the audit log", async () => {
    const cookie = await loginAs("accountant@audit.test");
    const res = await request(app).get("/api/audit-log").set("Cookie", cookie);
    expect(res.status).toBe(200);
  });

  it("filters by a text search across description and actor name", async () => {
    const ownerCookie = await loginAs("owner@audit.test");
    const { year, classLevel, section } = await setUpPricedClass(ownerCookie);
    await request(app).post("/api/students/admit").set("Cookie", ownerCookie).send({
      admission_no: "2026/501", full_name: "Distinctive Name Xyz",
      academic_year_id: year.id, class_level_id: classLevel.id, section_id: section.id,
    });

    const found = await request(app).get("/api/audit-log?q=Distinctive").set("Cookie", ownerCookie);
    expect(found.body.length).toBeGreaterThan(0);
    expect(found.body.every((e: any) => e.description.includes("Distinctive"))).toBe(true);

    const notFound = await request(app).get("/api/audit-log?q=NoSuchThingAtAll").set("Cookie", ownerCookie);
    expect(notFound.body).toHaveLength(0);
  });

  it("anonymous requests are refused", async () => {
    const res = await request(app).get("/api/audit-log");
    // requireCapability alone (no preceding requireMember) always
    // returns 403 here, consistent with every other route gated only by
    // requireCapability — it doesn't distinguish "no session at all"
    // from "signed in with the wrong role."
    expect(res.status).toBe(403);
  });
});
