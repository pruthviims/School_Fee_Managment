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

  school = await createSchool({ short_code: "import-http-test" });
  owner = await createUser("owner@import.test", "x".repeat(14));
  await createMembership(owner.id, school.id, "owner");
  viewer = await createUser("viewer@import.test", "x".repeat(14));
  await createMembership(viewer.id, school.id, "viewer");
});

afterAll(async () => {
  await pool.end();
});

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: "x".repeat(14) });
  return res.headers["set-cookie"];
}

describe("import routes", () => {
  it("stages, reviews, and commits a roll end to end over HTTP", async () => {
    const cookie = await loginAs("owner@import.test");
    const year = await request(app).post("/api/setup/academic-years").set("Cookie", cookie)
      .send({ name: "2026-27", starts_on: "2026-06-01", ends_on: "2027-03-31", status: "active" });
    await request(app).post("/api/setup/class-levels").set("Cookie", cookie)
      .send({ name: "VIII", ladder_order: 8, stage: "middle" });

    const csv = "Adm No,Name,Class\n2026/1,Good Row,VIII\n,Bad Row,VIII\n";
    const stage = await request(app).post("/api/import/stage").set("Cookie", cookie).send({
      academic_year_id: year.body.id, filename: "roll.csv", content: csv,
    });
    expect(stage.status).toBe(201);
    expect(stage.body.valid_rows).toBe(1);
    expect(stage.body.total_rows).toBe(2);

    const rows = await request(app).get(`/api/import/batches/${stage.body.id}/rows`)
      .set("Cookie", cookie);
    expect(rows.status).toBe(200);
    expect(rows.body.rows).toHaveLength(2);

    const errorsOnly = await request(app)
      .get(`/api/import/batches/${stage.body.id}/rows?errors_only=1`).set("Cookie", cookie);
    expect(errorsOnly.body.rows).toHaveLength(1);
    expect(errorsOnly.body.rows[0].errors[0]).toContain("blank");

    const commit = await request(app).post(`/api/import/batches/${stage.body.id}/commit`)
      .set("Cookie", cookie).send({});
    expect(commit.status).toBe(200);
    expect(commit.body.created).toBe(1);
    expect(commit.body.skipped).toBe(1);
  });

  it("returns a real 400, not a 500, when required columns can't be found", async () => {
    const cookie = await loginAs("owner@import.test");
    const year = await request(app).post("/api/setup/academic-years").set("Cookie", cookie)
      .send({ name: "2026-27", starts_on: "2026-06-01", ends_on: "2027-03-31" });

    const stage = await request(app).post("/api/import/stage").set("Cookie", cookie).send({
      academic_year_id: year.body.id, filename: "roll.csv", content: "Foo,Bar\n1,2\n",
    });
    expect(stage.status).toBe(400);
  });

  it("serves the blank template as a downloadable CSV", async () => {
    const cookie = await loginAs("owner@import.test");
    const res = await request(app).get("/api/import/template").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.text).toContain("Admission No");
  });

  it("a viewer (no manage_admissions) cannot stage an import", async () => {
    const cookie = await loginAs("viewer@import.test");
    const res = await request(app).post("/api/import/stage").set("Cookie", cookie).send({
      academic_year_id: "00000000-0000-0000-0000-000000000000", filename: "x.csv", content: "a,b\n1,2\n",
    });
    expect(res.status).toBe(403);
  });

  it("anonymous requests are refused", async () => {
    const res = await request(app).get("/api/import/template");
    expect(res.status).toBe(403);
  });
});
