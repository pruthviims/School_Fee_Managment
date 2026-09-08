import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../app.js";
import { pool } from "../db/index.js";
import { createMembership, createSchool, createUser, resetDb } from "../tests/helpers.js";

let school: any;

beforeEach(async () => {
  await resetDb();
  school = await createSchool({ short_code: "logo-test" });
  const owner = await createUser("owner@logotest.test", "x".repeat(14));
  await createMembership(owner.id, school.id, "owner");
  const frontDesk = await createUser("desk@logotest.test", "x".repeat(14));
  await createMembership(frontDesk.id, school.id, "front_desk");
});

afterAll(async () => {
  await pool.end();
});

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: "x".repeat(14) });
  return res.headers["set-cookie"];
}

// A minimal, genuinely valid 1x1 PNG, base64-encoded — small enough to
// stay well under the size cap while still being real image bytes, not
// just a plausible-looking string.
const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("school logo", () => {
  it("an owner can upload a real logo, and it comes back from /me", async () => {
    const cookie = await loginAs("owner@logotest.test");
    const res = await request(app).patch("/api/school/logo").set("Cookie", cookie)
      .send({ logo_data_url: TINY_PNG_DATA_URL });
    expect(res.status).toBe(200);
    expect(res.body.logo_data_url).toBe(TINY_PNG_DATA_URL);

    const me = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(me.body.school.logo_data_url).toBe(TINY_PNG_DATA_URL);
  });

  it("an owner can remove a logo by sending an empty string", async () => {
    const cookie = await loginAs("owner@logotest.test");
    await request(app).patch("/api/school/logo").set("Cookie", cookie)
      .send({ logo_data_url: TINY_PNG_DATA_URL });
    const res = await request(app).patch("/api/school/logo").set("Cookie", cookie)
      .send({ logo_data_url: "" });
    expect(res.status).toBe(200);
    expect(res.body.logo_data_url).toBe("");
  });

  it("refuses something that isn't an image data URL", async () => {
    const cookie = await loginAs("owner@logotest.test");
    const res = await request(app).patch("/api/school/logo").set("Cookie", cookie)
      .send({ logo_data_url: "not an image at all" });
    expect(res.status).toBe(400);
  });

  it("refuses a logo over the size cap", async () => {
    const cookie = await loginAs("owner@logotest.test");
    const huge = "data:image/png;base64," + "A".repeat(700 * 1024); // ~525KB of real bytes once decoded
    const res = await request(app).patch("/api/school/logo").set("Cookie", cookie)
      .send({ logo_data_url: huge });
    expect(res.status).toBe(400);
  });

  it("refuses a request so large it exceeds the body parser's own limit, with a real 413", async () => {
    const cookie = await loginAs("owner@logotest.test");
    // Bigger than express.json()'s 2mb limit itself, not just the
    // application-level 500KB logo cap — this never reaches the route
    // handler at all, so it's a genuinely different failure path.
    const tooBigForBodyParser = "data:image/png;base64," + "A".repeat(3 * 1024 * 1024);
    const res = await request(app).patch("/api/school/logo").set("Cookie", cookie)
      .send({ logo_data_url: tooBigForBodyParser });
    expect(res.status).toBe(413);
  });

  it("front desk cannot upload a logo — owner-only", async () => {
    const cookie = await loginAs("desk@logotest.test");
    const res = await request(app).patch("/api/school/logo").set("Cookie", cookie)
      .send({ logo_data_url: TINY_PNG_DATA_URL });
    expect(res.status).toBe(403);
  });

  it("the public school-lookup endpoint reflects the real uploaded logo", async () => {
    const cookie = await loginAs("owner@logotest.test");
    await request(app).patch("/api/school/logo").set("Cookie", cookie)
      .send({ logo_data_url: TINY_PNG_DATA_URL });

    const lookup = await request(app).get("/api/auth/schools/logo-test");
    expect(lookup.status).toBe(200);
    expect(lookup.body.logo_data_url).toBe(TINY_PNG_DATA_URL);
  });
});
