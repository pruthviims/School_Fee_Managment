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
  school = await createSchool({ short_code: "transport-test" });
  const owner = await createUser("owner@transport.test", "x".repeat(14));
  await createMembership(owner.id, school.id, "owner");
  const desk = await createUser("desk@transport.test", "x".repeat(14));
  await createMembership(desk.id, school.id, "front_desk");
});

afterAll(async () => {
  await pool.end();
});

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: "x".repeat(14) });
  return res.headers["set-cookie"];
}

async function setUpRouteStopFareAndStudent(cookie: string, annualFarePaise = 5000000) {
  const year = await request(app).post("/api/setup/academic-years").set("Cookie", cookie)
    .send({ name: "2026-27", starts_on: "2026-06-01", ends_on: "2027-03-31", status: "active" });
  const classLevel = await request(app).post("/api/setup/class-levels").set("Cookie", cookie)
    .send({ name: "VIII", ladder_order: 8, stage: "middle" });
  const section = await request(app).post("/api/setup/sections").set("Cookie", cookie).send({
    academic_year_id: year.body.id, class_level_id: classLevel.body.id, name: "A",
  });
  // A regular (non-transport) fee needs to be priced too — New Admission
  // now refuses to admit into a class with no fees set up at all.
  const tuitionHead = await request(app).post("/api/setup/fee-heads").set("Cookie", cookie)
    .send({ name: "Tuition fee" });
  await request(app).post("/api/setup/fee-structure").set("Cookie", cookie).send({
    academic_year_id: year.body.id, class_level_id: classLevel.body.id,
    fee_head_id: tuitionHead.body.id, amount: 4000000, due_on: "2026-06-15",
  });
  const route = await request(app).post("/api/transport/routes").set("Cookie", cookie)
    .send({ code: "R-01", name: "Jayanagar Route" });
  const stop = await request(app).post(`/api/transport/routes/${route.body.id}/stops`).set("Cookie", cookie)
    .send({ name: "4th Block", sequence: 1 });
  await request(app).post("/api/transport/fares").set("Cookie", cookie).send({
    academic_year_id: year.body.id, stop_id: stop.body.id, amount: annualFarePaise, due_on: "2026-06-15",
  });
  const admission = await request(app).post("/api/students/admit").set("Cookie", cookie).send({
    admission_no: "2026/700", full_name: "Test Rider",
    academic_year_id: year.body.id, class_level_id: classLevel.body.id, section_id: section.body.id,
  });
  return { year: year.body, route: route.body, stop: stop.body, enrollment: admission.body.enrollment };
}

describe("bus routes", () => {
  it("an accountant can create a route and its stops", async () => {
    const cookie = await loginAs("owner@transport.test");
    const route = await request(app).post("/api/transport/routes").set("Cookie", cookie)
      .send({ code: "R-04", name: "Banashankari Route", driver_name: "M. Suresh", seats: 45 });
    expect(route.status).toBe(201);

    const stop = await request(app).post(`/api/transport/routes/${route.body.id}/stops`)
      .set("Cookie", cookie).send({ name: "BSK 2nd Stage", sequence: 1 });
    expect(stop.status).toBe(201);

    const list = await request(app).get("/api/transport/routes").set("Cookie", cookie);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].code).toBe("R-04");
  });

  it("rejects a duplicate route code", async () => {
    const cookie = await loginAs("owner@transport.test");
    await request(app).post("/api/transport/routes").set("Cookie", cookie)
      .send({ code: "R-01", name: "First" });
    const dup = await request(app).post("/api/transport/routes").set("Cookie", cookie)
      .send({ code: "R-01", name: "Second" });
    expect(dup.status).toBe(409);
  });

  it("creates a route or stop with no name yet — filled in inline right after in the UI", async () => {
    const cookie = await loginAs("owner@transport.test");
    const route = await request(app).post("/api/transport/routes").set("Cookie", cookie)
      .send({ code: "R-09" }); // no name at all
    expect(route.status).toBe(201);
    expect(route.body.name).toBe("");

    const stop = await request(app).post(`/api/transport/routes/${route.body.id}/stops`)
      .set("Cookie", cookie).send({}); // no name at all
    expect(stop.status).toBe(201);
    expect(stop.body.name).toBe("");
  });

  it("front desk cannot create a route (manage_fee_structure required)", async () => {
    const cookie = await loginAs("desk@transport.test");
    const res = await request(app).post("/api/transport/routes").set("Cookie", cookie)
      .send({ code: "R-01", name: "Test" });
    expect(res.status).toBe(403);
  });

  it("refuses to delete a route whose stop is already priced", async () => {
    const cookie = await loginAs("owner@transport.test");
    const { route } = await setUpRouteStopFareAndStudent(cookie);
    const res = await request(app).delete(`/api/transport/routes/${route.id}`).set("Cookie", cookie);
    expect(res.status).toBe(409);
  });
});

describe("fares", () => {
  it("rejects a duplicate fare for the same stop and year", async () => {
    const cookie = await loginAs("owner@transport.test");
    const { year, stop } = await setUpRouteStopFareAndStudent(cookie);
    const dup = await request(app).post("/api/transport/fares").set("Cookie", cookie).send({
      academic_year_id: year.id, stop_id: stop.id, amount: 1000000, due_on: "2026-06-15",
    });
    expect(dup.status).toBe(409);
  });

  it("lists fares with route and stop names for display", async () => {
    const cookie = await loginAs("owner@transport.test");
    const { year } = await setUpRouteStopFareAndStudent(cookie);
    const list = await request(app).get(`/api/transport/fares?academic_year_id=${year.id}`)
      .set("Cookie", cookie);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].stop_name).toBe("4th Block");
    expect(list.body[0].route_code).toBe("R-01");
  });
});

describe("assigning a student — the actual proration", () => {
  it("computes the prorated fee correctly and posts it as a real charge", async () => {
    const cookie = await loginAs("owner@transport.test");
    // Annual fare 50,000 rupees = 5,000,000 paise. 7 of 10 months.
    const { stop, enrollment } = await setUpRouteStopFareAndStudent(cookie, 5000000);

    const res = await request(app).post(`/api/transport/enrollments/${enrollment.id}/assign`)
      .set("Cookie", cookie).send({ stop_id: stop.id, months: 7 });
    expect(res.status).toBe(201);
    // 5,000,000 / 10 * 7 = 3,500,000
    expect(res.body.charge.amount).toBe(3500000);
    expect(res.body.charge.head_name).toBe("Transport fee");
    expect(res.body.annual_fare).toBe(5000000);

    const ledger = await request(app).get(`/api/students/enrollments/${enrollment.id}/ledger`)
      .set("Cookie", cookie);
    // Transport (3,500,000) + the tuition fee setUpRouteStopFareAndStudent
    // also prices for admission to succeed at all (4,000,000).
    expect(ledger.body.charged).toBe(7500000);
  });

  it("riding the full 10 months charges the full annual fare", async () => {
    const cookie = await loginAs("owner@transport.test");
    const { stop, enrollment } = await setUpRouteStopFareAndStudent(cookie, 5000000);
    const res = await request(app).post(`/api/transport/enrollments/${enrollment.id}/assign`)
      .set("Cookie", cookie).send({ stop_id: stop.id, months: 10 });
    expect(res.body.charge.amount).toBe(5000000);
  });

  it("refuses more than 10 months — the academic year is 10 months, not 12", async () => {
    const cookie = await loginAs("owner@transport.test");
    const { stop, enrollment } = await setUpRouteStopFareAndStudent(cookie);
    const res = await request(app).post(`/api/transport/enrollments/${enrollment.id}/assign`)
      .set("Cookie", cookie).send({ stop_id: stop.id, months: 12 });
    expect(res.status).toBe(400);
  });

  it("refuses to assign a stop that has no fare set for this year", async () => {
    const cookie = await loginAs("owner@transport.test");
    const { route, enrollment } = await setUpRouteStopFareAndStudent(cookie);
    const unpriced = await request(app).post(`/api/transport/routes/${route.id}/stops`)
      .set("Cookie", cookie).send({ name: "No Fare Stop", sequence: 2 });
    const res = await request(app).post(`/api/transport/enrollments/${enrollment.id}/assign`)
      .set("Cookie", cookie).send({ stop_id: unpriced.body.id, months: 5 });
    expect(res.status).toBe(400);
  });

  it("refuses a stop whose fare is explicitly set to zero, not just missing", async () => {
    const cookie = await loginAs("owner@transport.test");
    const { year, route, enrollment } = await setUpRouteStopFareAndStudent(cookie);
    const zeroStop = await request(app).post(`/api/transport/routes/${route.id}/stops`)
      .set("Cookie", cookie).send({ name: "Zero Fare Stop", sequence: 2 });
    await request(app).post("/api/transport/fares").set("Cookie", cookie).send({
      academic_year_id: year.id, stop_id: zeroStop.body.id, amount: 0, due_on: "2026-06-15",
    });
    const res = await request(app).post(`/api/transport/enrollments/${enrollment.id}/assign`)
      .set("Cookie", cookie).send({ stop_id: zeroStop.body.id, months: 5 });
    expect(res.status).toBe(400);
  });

  it("reassigning mid-year reverses the old charge and posts a new one, not both", async () => {
    const cookie = await loginAs("owner@transport.test");
    const { stop, enrollment } = await setUpRouteStopFareAndStudent(cookie, 5000000);
    await request(app).post(`/api/transport/enrollments/${enrollment.id}/assign`)
      .set("Cookie", cookie).send({ stop_id: stop.id, months: 5 }); // 2,500,000

    const second = await request(app).post(`/api/transport/enrollments/${enrollment.id}/assign`)
      .set("Cookie", cookie).send({ stop_id: stop.id, months: 10 }); // extends to full year
    expect(second.status).toBe(201);
    expect(second.body.charge.amount).toBe(5000000);

    // Only the new transport charge counts, not both — plus the tuition
    // fee setUpRouteStopFareAndStudent also prices (4,000,000).
    const ledger = await request(app).get(`/api/students/enrollments/${enrollment.id}/ledger`)
      .set("Cookie", cookie);
    expect(ledger.body.charged).toBe(9000000);
  });

  it("front desk can assign transport (manage_admissions), not configure routes or fares", async () => {
    const ownerCookie = await loginAs("owner@transport.test");
    const { stop, enrollment } = await setUpRouteStopFareAndStudent(ownerCookie);

    const deskCookie = await loginAs("desk@transport.test");
    const res = await request(app).post(`/api/transport/enrollments/${enrollment.id}/assign`)
      .set("Cookie", deskCookie).send({ stop_id: stop.id, months: 6 });
    expect(res.status).toBe(201);
  });

  it("ending an assignment reverses its charge — balance goes back to zero", async () => {
    const cookie = await loginAs("owner@transport.test");
    const { stop, enrollment } = await setUpRouteStopFareAndStudent(cookie, 5000000);
    const assigned = await request(app).post(`/api/transport/enrollments/${enrollment.id}/assign`)
      .set("Cookie", cookie).send({ stop_id: stop.id, months: 7 });

    const end = await request(app)
      .post(`/api/transport/assignments/${assigned.body.assignment.id}/end`).set("Cookie", cookie);
    expect(end.status).toBe(204);

    const ledger = await request(app).get(`/api/students/enrollments/${enrollment.id}/ledger`)
      .set("Cookie", cookie);
    // The transport charge is reversed; the tuition fee
    // setUpRouteStopFareAndStudent also prices (4,000,000) remains.
    expect(ledger.body.charged).toBe(4000000);

    const current = await request(app).get(`/api/transport/enrollments/${enrollment.id}/assignment`)
      .set("Cookie", cookie);
    expect(current.body).toBeNull();
  });

  it("GET .../assignment returns the currently active assignment", async () => {
    const cookie = await loginAs("owner@transport.test");
    const { stop, enrollment } = await setUpRouteStopFareAndStudent(cookie);
    await request(app).post(`/api/transport/enrollments/${enrollment.id}/assign`)
      .set("Cookie", cookie).send({ stop_id: stop.id, months: 4 });

    const current = await request(app).get(`/api/transport/enrollments/${enrollment.id}/assignment`)
      .set("Cookie", cookie);
    expect(current.body.stop_id).toBe(stop.id);
    expect(current.body.months).toBe(4);
  });

  it("counts riders per stop for the year", async () => {
    const cookie = await loginAs("owner@transport.test");
    const { year, stop, enrollment } = await setUpRouteStopFareAndStudent(cookie, 5000000);
    await request(app).post(`/api/transport/enrollments/${enrollment.id}/assign`)
      .set("Cookie", cookie).send({ stop_id: stop.id, months: 6 });

    const riders = await request(app).get(`/api/transport/riders?academic_year_id=${year.id}`)
      .set("Cookie", cookie);
    expect(riders.body).toEqual([{ stop_id: stop.id, riders: 1 }]);
  });

  it("a transport concession is a real concession tagged to the Transport fee head", async () => {
    const cookie = await loginAs("owner@transport.test");
    const { stop, enrollment } = await setUpRouteStopFareAndStudent(cookie, 5000000);
    const assigned = await request(app).post(`/api/transport/enrollments/${enrollment.id}/assign`)
      .set("Cookie", cookie).send({ stop_id: stop.id, months: 10 });
    const transportHeadId = assigned.body.charge.fee_head_id;

    const concession = await request(app)
      .post(`/api/students/enrollments/${enrollment.id}/concessions`).set("Cookie", cookie)
      .send({ amount: 1000000, reason: "hardship", fee_head_id: transportHeadId,
              approver_name: "Dr. S. Gowda (Principal)" });
    expect(concession.status).toBe(201);
    expect(concession.body.fee_head_id).toBe(transportHeadId);

    const ledger = await request(app).get(`/api/students/enrollments/${enrollment.id}/ledger`)
      .set("Cookie", cookie);
    // Transport (5,000,000) + the tuition fee setUpRouteStopFareAndStudent
    // also prices for admission to succeed at all (4,000,000).
    expect(ledger.body.charged).toBe(9000000);
    expect(ledger.body.conceded).toBe(1000000);
    expect(ledger.body.balance).toBe(8000000);
  });
});
