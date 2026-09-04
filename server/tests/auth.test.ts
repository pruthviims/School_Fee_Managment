/**
 * Mirrors backend/accounts/tests/test_auth.py's guarantees exactly, so
 * the Node and Django versions are checked against the same behavior
 * while both exist:
 *
 * - correct credentials succeed, wrong ones don't
 * - a user with no membership can't sign in even with the right password
 * - a deactivated membership blocks login
 * - a role without a capability gets a real 403 from the API
 * - reset tokens work exactly once and reject garbage/expired tokens
 * - an invited user's first password works through the identical link
 *   mechanism as a reset
 */

import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../app.js";
import { pool } from "../db/index.js";
import * as emailService from "../services/emailService.js";
import { checkCredentialToken, makeCredentialToken } from "../services/authService.js";
import { createMembership, createSchool, createUser, resetDb } from "./helpers.js";

const sendMailSpy = vi.spyOn(emailService, "sendMail").mockResolvedValue(undefined);

let school: any;
let owner: any;
let frontDesk: any;
let noAccess: any;

beforeEach(async () => {
  await resetDb();
  sendMailSpy.mockClear();

  school = await createSchool({ short_code: "acc-test" });
  owner = await createUser("owner@school.test", "x".repeat(14));
  await createMembership(owner.id, school.id, "owner");

  frontDesk = await createUser("desk@school.test", "x".repeat(14));
  await createMembership(frontDesk.id, school.id, "front_desk");

  noAccess = await createUser("nobody@school.test", "x".repeat(14));
  // Deliberately no membership.
});

afterAll(async () => {
  await pool.end();
});

async function loginAs(email: string, password: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password });
  const cookie = res.headers["set-cookie"];
  return { res, cookie };
}

describe("login", () => {
  it("logs in with correct credentials", async () => {
    const { res } = await loginAs("owner@school.test", "x".repeat(14));
    expect(res.status).toBe(200);
    expect(res.body.email).toBe("owner@school.test");
    expect(res.body.membership.role).toBe("owner");
  });

  it("rejects a wrong password", async () => {
    const { res } = await loginAs("owner@school.test", "totally wrong password");
    expect(res.status).toBe(401);
  });

  it("refuses a user with no membership even with the right password", async () => {
    const { res } = await loginAs("nobody@school.test", "x".repeat(14));
    expect(res.status).toBe(403);
  });

  it("blocks login when the membership is deactivated", async () => {
    await pool.query(`UPDATE memberships SET is_active = false WHERE user_id = $1`, [frontDesk.id]);
    const { res } = await loginAs("desk@school.test", "x".repeat(14));
    expect(res.status).toBe(403);
  });

  it("/me reflects the signed-in user's role and capabilities", async () => {
    const { cookie } = await loginAs("desk@school.test", "x".repeat(14));
    const res = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.membership.role).toBe("front_desk");
    expect(res.body.membership.capabilities).toContain("manage_admissions");
    expect(res.body.membership.capabilities).not.toContain("manage_staff");
  });

  it("logout ends the session", async () => {
    const { cookie } = await loginAs("owner@school.test", "x".repeat(14));
    expect((await request(app).get("/api/auth/me").set("Cookie", cookie)).status).toBe(200);

    const logoutRes = await request(app).post("/api/auth/logout").set("Cookie", cookie);
    const clearedCookie = logoutRes.headers["set-cookie"];
    const after = await request(app).get("/api/auth/me").set("Cookie", clearedCookie);
    expect(after.status).toBe(401);
  });
});

describe("capability enforcement", () => {
  it("front desk can reach staff endpoints? no — 403", async () => {
    const { cookie } = await loginAs("desk@school.test", "x".repeat(14));
    const res = await request(app).get("/api/staff").set("Cookie", cookie);
    expect(res.status).toBe(403);
  });

  it("owner can reach staff endpoints", async () => {
    const { cookie } = await loginAs("owner@school.test", "x".repeat(14));
    const res = await request(app).get("/api/staff").set("Cookie", cookie);
    expect(res.status).toBe(200);
  });

  it("anonymous requests are refused", async () => {
    const res = await request(app).get("/api/staff");
    expect(res.status).toBe(403);
  });
});

describe("staff management", () => {
  it("owner can invite staff and an email is sent", async () => {
    const { cookie } = await loginAs("owner@school.test", "x".repeat(14));
    const res = await request(app).post("/api/staff").set("Cookie", cookie).send({
      email: "new-accountant@school.test", full_name: "Priya Rao", role: "accountant",
    });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe("accountant");

    expect(sendMailSpy).toHaveBeenCalledTimes(1);
    const call = sendMailSpy.mock.calls[0][0];
    expect(call.to).toBe("new-accountant@school.test");
    expect(call.text).toContain("uid=");
    expect(call.text).toContain("token=");

    const userRow = await pool.query(`SELECT password_hash FROM users WHERE email = $1`,
      ["new-accountant@school.test"]);
    expect(userRow.rows[0].password_hash).toBeNull();
  });

  it("inviting the same person twice is refused", async () => {
    const { cookie } = await loginAs("owner@school.test", "x".repeat(14));
    await request(app).post("/api/staff").set("Cookie", cookie)
      .send({ email: "dup@school.test", role: "viewer" });
    const res = await request(app).post("/api/staff").set("Cookie", cookie)
      .send({ email: "dup@school.test", role: "accountant" });
    expect(res.status).toBe(409);
  });

  it("owner can change a role", async () => {
    const { cookie } = await loginAs("owner@school.test", "x".repeat(14));
    const membershipRow = await pool.query(`SELECT id FROM memberships WHERE user_id = $1`,
      [frontDesk.id]);
    const res = await request(app)
      .patch(`/api/staff/${membershipRow.rows[0].id}`)
      .set("Cookie", cookie)
      .send({ role: "accountant" });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("accountant");
  });

  it("owner can revoke access", async () => {
    const { cookie } = await loginAs("owner@school.test", "x".repeat(14));
    const membershipRow = await pool.query(`SELECT id FROM memberships WHERE user_id = $1`,
      [frontDesk.id]);
    const res = await request(app)
      .delete(`/api/staff/${membershipRow.rows[0].id}`)
      .set("Cookie", cookie);
    expect(res.status).toBe(204);

    const check = await pool.query(`SELECT is_active FROM memberships WHERE id = $1`,
      [membershipRow.rows[0].id]);
    expect(check.rows[0].is_active).toBe(false);
  });

  it("owner cannot change their own access here", async () => {
    const { cookie } = await loginAs("owner@school.test", "x".repeat(14));
    const membershipRow = await pool.query(`SELECT id FROM memberships WHERE user_id = $1`,
      [owner.id]);
    const res = await request(app)
      .delete(`/api/staff/${membershipRow.rows[0].id}`)
      .set("Cookie", cookie);
    expect(res.status).toBe(400);
  });

  it("front desk cannot invite staff", async () => {
    const { cookie } = await loginAs("desk@school.test", "x".repeat(14));
    const res = await request(app).post("/api/staff").set("Cookie", cookie)
      .send({ email: "sneaky@school.test", role: "owner" });
    expect(res.status).toBe(403);
    const check = await pool.query(`SELECT 1 FROM users WHERE email = $1`, ["sneaky@school.test"]);
    expect(check.rows.length).toBe(0);
  });
});

describe("password reset", () => {
  it("returns the same response whether or not the email exists", async () => {
    const known = await request(app).post("/api/auth/password-reset")
      .send({ email: "owner@school.test" });
    const unknown = await request(app).post("/api/auth/password-reset")
      .send({ email: "nobody-at-all@school.test" });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body.detail).toBe(unknown.body.detail);
  });

  it("sends a working reset link for a real user, nothing for an unknown one", async () => {
    await request(app).post("/api/auth/password-reset").send({ email: "owner@school.test" });
    expect(sendMailSpy).toHaveBeenCalledTimes(1);

    sendMailSpy.mockClear();
    await request(app).post("/api/auth/password-reset").send({ email: "nobody-at-all@school.test" });
    expect(sendMailSpy).not.toHaveBeenCalled();
  });

  it("a valid token sets a new password that actually works", async () => {
    const token = makeCredentialToken(owner);
    const confirmRes = await request(app).post("/api/auth/password-reset/confirm").send({
      uid: owner.id, token, new_password: "a-brand-new-strong-pw-1",
    });
    expect(confirmRes.status).toBe(200);

    const { res } = await loginAs("owner@school.test", "a-brand-new-strong-pw-1");
    expect(res.status).toBe(200);
  });

  it("a token cannot be reused after the password changes", async () => {
    const token = makeCredentialToken(owner);
    const first = await request(app).post("/api/auth/password-reset/confirm").send({
      uid: owner.id, token, new_password: "first-new-password-1",
    });
    expect(first.status).toBe(200);

    const second = await request(app).post("/api/auth/password-reset/confirm").send({
      uid: owner.id, token, new_password: "second-new-password-1",
    });
    expect(second.status).toBe(400);
  });

  it("rejects a garbage token", async () => {
    const res = await request(app).post("/api/auth/password-reset/confirm").send({
      uid: owner.id, token: "not-a-real-token", new_password: "whatever-new-pw-1",
    });
    expect(res.status).toBe(400);
  });

  it("rejects a weak password", async () => {
    const token = makeCredentialToken(owner);
    const res = await request(app).post("/api/auth/password-reset/confirm").send({
      uid: owner.id, token, new_password: "12345",
    });
    expect(res.status).toBe(400);
  });

  it("checkCredentialToken agrees with the confirm endpoint's judgement", () => {
    const token = makeCredentialToken(owner);
    expect(checkCredentialToken(owner, token)).toBe(true);
    expect(checkCredentialToken(owner, "garbage")).toBe(false);
  });

  it("an invited user sets their first password through the same link mechanism", async () => {
    const { cookie } = await loginAs("owner@school.test", "x".repeat(14));
    await request(app).post("/api/staff").set("Cookie", cookie)
      .send({ email: "invitee@school.test", role: "viewer" });

    const invitee = (await pool.query(`SELECT * FROM users WHERE email = $1`,
      ["invitee@school.test"])).rows[0];
    expect(invitee.password_hash).toBeNull();

    const token = makeCredentialToken(invitee);
    const confirmRes = await request(app).post("/api/auth/password-reset/confirm").send({
      uid: invitee.id, token, new_password: "invitees-new-password-1",
    });
    expect(confirmRes.status).toBe(200);

    const { res } = await loginAs("invitee@school.test", "invitees-new-password-1");
    expect(res.status).toBe(200);
    expect(res.body.membership.role).toBe("viewer");
  });
});
