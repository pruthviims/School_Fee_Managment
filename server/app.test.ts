import request from "supertest";
import { describe, expect, it } from "vitest";
import { app } from "./app.js";

describe("CORS", () => {
  it("allows a request from a different *.vercel.app preview URL than FRONTEND_URL itself", async () => {
    // Exactly the real-world case that broke: FRONTEND_URL is set to the
    // production alias, but the office is actually testing on Vercel's
    // auto-generated per-branch preview URL, a different origin.
    const res = await request(app)
      .get("/api/health")
      .set("Origin", "https://school-fee-counter-git-main-pruthviims-projects.vercel.app");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"])
      .toBe("https://school-fee-counter-git-main-pruthviims-projects.vercel.app");
  });

  it("still refuses a request from an unrelated origin", async () => {
    const res = await request(app)
      .get("/api/health")
      .set("Origin", "https://some-other-app-entirely.example.com");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
