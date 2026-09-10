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

  describe("gender, family details, and generating real charges from import", () => {
    async function priceVIII(cookie: string, yearId: string) {
      const classLevel = await request(app).post("/api/setup/class-levels").set("Cookie", cookie)
        .send({ name: "VIII", ladder_order: 8, stage: "middle" });
      const feeHead = await request(app).post("/api/setup/fee-heads").set("Cookie", cookie)
        .send({ name: "Tuition fee" });
      await request(app).post("/api/setup/fee-structure").set("Cookie", cookie).send({
        academic_year_id: yearId, class_level_id: classLevel.body.id,
        fee_head_id: feeHead.body.id, amount: 4000000, due_on: "2026-06-15",
      });
      return classLevel.body;
    }

    it("imports gender, blood group, and Parents details, and generates real charges", async () => {
      const cookie = await loginAs("owner@import.test");
      const year = await request(app).post("/api/setup/academic-years").set("Cookie", cookie)
        .send({ name: "2026-27", starts_on: "2026-06-01", ends_on: "2027-03-31", status: "active" });
      await priceVIII(cookie, year.body.id);

      const csv = "Admission No,Name,Class,Gender,Blood Group,Father Name,Father Phone,Mother Name\n" +
        "2026/1,Ravi Kumar,VIII,Male,O+,Suresh Rao,9000000001,Lakshmi Rao\n";
      const stage = await request(app).post("/api/import/stage").set("Cookie", cookie).send({
        academic_year_id: year.body.id, filename: "roll.csv", content: csv,
      });
      expect(stage.status).toBe(201);
      expect(stage.body.valid_rows).toBe(1);

      const commit = await request(app).post(`/api/import/batches/${stage.body.id}/commit`)
        .set("Cookie", cookie).send({});
      expect(commit.status).toBe(200);
      expect(commit.body.created).toBe(1);
      expect(commit.body.unpriced).toEqual([]);

      const student = await pool.query(
        `SELECT gender, blood_group, contact_type, father_name, mother_name, guardian_name
         FROM students WHERE admission_no = '2026/1'`,
      );
      expect(student.rows[0].gender).toBe("male");
      expect(student.rows[0].blood_group).toBe("O+");
      expect(student.rows[0].contact_type).toBe("parents");
      expect(student.rows[0].father_name).toBe("Suresh Rao");
      expect(student.rows[0].mother_name).toBe("Lakshmi Rao");
      // Primary contact correctly derived from the father, same as a
      // normal admission would.
      expect(student.rows[0].guardian_name).toBe("Suresh Rao");

      const charges = await pool.query(
        `SELECT c.amount FROM charges c
         JOIN enrollments e ON e.id = c.enrollment_id
         JOIN students s ON s.id = e.student_id
         WHERE s.admission_no = '2026/1'`,
      );
      expect(charges.rows).toHaveLength(1);
      expect(charges.rows[0].amount).toBe(4000000);
    });

    it("imports Guardian details (relationship + name) when no father/mother is given", async () => {
      const cookie = await loginAs("owner@import.test");
      const year = await request(app).post("/api/setup/academic-years").set("Cookie", cookie)
        .send({ name: "2026-27", starts_on: "2026-06-01", ends_on: "2027-03-31", status: "active" });
      await priceVIII(cookie, year.body.id);

      const csv = "Admission No,Name,Class,Gender,Guardian Relationship,Guardian Name,Phone\n" +
        "2026/2,Priya Nair,VIII,Female,Grandmother,Kamala Devi,9000000009\n";
      const stage = await request(app).post("/api/import/stage").set("Cookie", cookie).send({
        academic_year_id: year.body.id, filename: "roll.csv", content: csv,
      });
      await request(app).post(`/api/import/batches/${stage.body.id}/commit`)
        .set("Cookie", cookie).send({});

      const student = await pool.query(
        `SELECT contact_type, guardian_relationship, guardian_name, guardian_phone
         FROM students WHERE admission_no = '2026/2'`,
      );
      expect(student.rows[0].contact_type).toBe("guardian");
      expect(student.rows[0].guardian_relationship).toBe("Grandmother");
      expect(student.rows[0].guardian_name).toBe("Kamala Devi");
      expect(student.rows[0].guardian_phone).toBe("9000000009");
    });

    it("records 'amount paid so far' as a real payment against the generated charges", async () => {
      const cookie = await loginAs("owner@import.test");
      const year = await request(app).post("/api/setup/academic-years").set("Cookie", cookie)
        .send({ name: "2026-27", starts_on: "2026-06-01", ends_on: "2027-03-31", status: "active" });
      await priceVIII(cookie, year.body.id);

      const csv = "Admission No,Name,Class,Gender,Amount Paid So Far\n" +
        "2026/3,Arjun Shetty,VIII,Male,15000\n";
      const stage = await request(app).post("/api/import/stage").set("Cookie", cookie).send({
        academic_year_id: year.body.id, filename: "roll.csv", content: csv,
      });
      await request(app).post(`/api/import/batches/${stage.body.id}/commit`)
        .set("Cookie", cookie).send({});

      const enrollment = await pool.query(
        `SELECT e.id FROM enrollments e JOIN students s ON s.id = e.student_id
         WHERE s.admission_no = '2026/3'`,
      );
      const ledger = await request(app).get(`/api/students/enrollments/${enrollment.rows[0].id}/ledger`)
        .set("Cookie", cookie);
      expect(ledger.body.charged).toBe(4000000); // full tuition
      expect(ledger.body.paid).toBe(1500000); // 15,000 rupees, from the sheet
      expect(ledger.body.balance).toBe(4000000 - 1500000); // the real remaining balance
    });

    it("still creates the student when their class isn't priced, but generates no charges and reports it", async () => {
      const cookie = await loginAs("owner@import.test");
      const year = await request(app).post("/api/setup/academic-years").set("Cookie", cookie)
        .send({ name: "2026-27", starts_on: "2026-06-01", ends_on: "2027-03-31", status: "active" });
      await request(app).post("/api/setup/class-levels").set("Cookie", cookie)
        .send({ name: "IX", ladder_order: 9, stage: "middle" }); // deliberately never priced

      const csv = "Admission No,Name,Class,Gender\n2026/4,Unpriced Student,IX,Male\n";
      const stage = await request(app).post("/api/import/stage").set("Cookie", cookie).send({
        academic_year_id: year.body.id, filename: "roll.csv", content: csv,
      });
      const commit = await request(app).post(`/api/import/batches/${stage.body.id}/commit`)
        .set("Cookie", cookie).send({});
      expect(commit.status).toBe(200);
      expect(commit.body.created).toBe(1); // student still created
      expect(commit.body.unpriced).toEqual(["IX"]); // but flagged as unbilled

      const charges = await pool.query(
        `SELECT c.id FROM charges c
         JOIN enrollments e ON e.id = c.enrollment_id
         JOIN students s ON s.id = e.student_id
         WHERE s.admission_no = '2026/4'`,
      );
      expect(charges.rows).toHaveLength(0); // no charges generated
    });
  });
});
