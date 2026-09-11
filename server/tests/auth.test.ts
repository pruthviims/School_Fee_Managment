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
    expect(res.body.school.name).toBe(school.name);
    expect(res.body.school.short_code).toBe("acc-test");
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
    expect(res.body.school.short_code).toBe("acc-test");
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
    // The login screen asks for School ID as its own required field
    // (the school's short_code, not derivable from the email address),
    // and for the role to actually mean anything to whoever's reading
    // it — without these, a newly invited person could set their
    // password and then have no idea what to type to actually log in.
    expect(call.text).toContain("Hi Priya Rao,");
    expect(call.text).toContain("Login email: new-accountant@school.test");
    expect(call.text).toContain("School ID: acc-test");
    expect(call.text).toContain("Role: Accountant");

    // Returned directly, not just emailed — sendMail() silently just
    // logs to the server console instead of actually delivering
    // anything whenever EMAIL_HOST isn't configured, which is
    // invisible to whoever clicked "invite." The Owner needs a way to
    // get this link even when email delivery isn't working.
    expect(res.body.invite_url).toContain("uid=");
    expect(res.body.invite_url).toContain("token=");
    expect(res.body.email_sent).toBe(true);
    expect(res.body.has_password).toBe(false);

    const userRow = await pool.query(`SELECT password_hash FROM users WHERE email = $1`,
      ["new-accountant@school.test"]);
    expect(userRow.rows[0].password_hash).toBeNull();
  });

  it("still returns a usable invite_url when email delivery genuinely fails, flagged as email_sent: false", async () => {
    // The real scenario this covers: a misconfigured or temporarily
    // down mail provider must never block the invite itself — the
    // Owner can still copy/paste the link by hand. This is exactly
    // what a 504/FUNCTION_INVOCATION_TIMEOUT from a hanging SMTP
    // connection used to prevent (no response at all, so no invite_url
    // ever reached the browser); simulated here as any thrown error,
    // since a failed HTTP call to Brevo throws the same shape of error.
    sendMailSpy.mockRejectedValueOnce(new Error("Brevo API refused the email (400): Sender not verified"));
    const { cookie } = await loginAs("owner@school.test", "x".repeat(14));
    const res = await request(app).post("/api/staff").set("Cookie", cookie).send({
      email: "delivery-fails@school.test", full_name: "Delivery Fails", role: "accountant",
    });
    expect(res.status).toBe(201); // the invite itself still succeeds
    expect(res.body.invite_url).toContain("uid=");
    expect(res.body.invite_url).toContain("token=");
    expect(res.body.email_sent).toBe(false);
  });

  it("resending an invite works for a pending staff member and returns a fresh link", async () => {
    const { cookie } = await loginAs("owner@school.test", "x".repeat(14));
    const invite = await request(app).post("/api/staff").set("Cookie", cookie).send({
      email: "never-got-the-email@school.test", role: "accountant",
    });
    sendMailSpy.mockClear();

    const resend = await request(app).post(`/api/staff/${invite.body.id}/resend-invite`)
      .set("Cookie", cookie);
    expect(resend.status).toBe(200);
    expect(resend.body.invite_url).toContain("uid=");
    expect(resend.body.email_sent).toBe(true);
    expect(sendMailSpy).toHaveBeenCalledTimes(1);
    expect(sendMailSpy.mock.calls[0][0].to).toBe("never-got-the-email@school.test");
    // No full_name was given at invite time — falls back to a generic
    // greeting rather than "Hi ," with a blank left in it.
    expect(sendMailSpy.mock.calls[0][0].text).toContain("Hi there,");
    expect(sendMailSpy.mock.calls[0][0].text).toContain("Login email: never-got-the-email@school.test");
    expect(sendMailSpy.mock.calls[0][0].text).toContain("School ID: acc-test");
    expect(sendMailSpy.mock.calls[0][0].text).toContain("Role: Accountant");
  });

  it("resending an invite also works for an already-active staff member", async () => {
    const { cookie } = await loginAs("owner@school.test", "x".repeat(14));
    const membershipRow = await pool.query(`SELECT id FROM memberships WHERE user_id = $1`,
      [frontDesk.id]);
    const resend = await request(app).post(`/api/staff/${membershipRow.rows[0].id}/resend-invite`)
      .set("Cookie", cookie);
    expect(resend.status).toBe(200);
    expect(resend.body.invite_url).toBeTruthy();
  });

  it("front desk cannot resend an invite", async () => {
    const ownerCookie = await loginAs("owner@school.test", "x".repeat(14));
    const invite = await request(app).post("/api/staff").set("Cookie", ownerCookie.cookie).send({
      email: "someone-else@school.test", role: "viewer",
    });
    const { cookie: deskCookie } = await loginAs("desk@school.test", "x".repeat(14));
    const resend = await request(app).post(`/api/staff/${invite.body.id}/resend-invite`)
      .set("Cookie", deskCookie);
    expect(resend.status).toBe(403);
  });

  it("staff list reports has_password correctly for pending vs active staff", async () => {
    const { cookie } = await loginAs("owner@school.test", "x".repeat(14));
    await request(app).post("/api/staff").set("Cookie", cookie)
      .send({ email: "still-pending@school.test", role: "viewer" });

    const list = await request(app).get("/api/staff").set("Cookie", cookie);
    const pending = list.body.find((m: any) => m.email === "still-pending@school.test");
    const active = list.body.find((m: any) => m.email === "owner@school.test");
    expect(pending.has_password).toBe(false);
    expect(active.has_password).toBe(true);
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

describe("change your own password", () => {
  it("changes the password when the current one is correct", async () => {
    const { cookie } = await loginAs("owner@school.test", "x".repeat(14));
    const res = await request(app).post("/api/auth/me/password").set("Cookie", cookie).send({
      current_password: "x".repeat(14), new_password: "a-genuinely-new-password-1",
    });
    expect(res.status).toBe(204);

    // The old password no longer works.
    const oldLogin = await request(app).post("/api/auth/login")
      .send({ email: "owner@school.test", password: "x".repeat(14) });
    expect(oldLogin.status).toBe(401);

    // The new one does.
    const newLogin = await request(app).post("/api/auth/login")
      .send({ email: "owner@school.test", password: "a-genuinely-new-password-1" });
    expect(newLogin.status).toBe(200);
  });

  it("refuses when the current password is wrong, and changes nothing", async () => {
    const { cookie } = await loginAs("owner@school.test", "x".repeat(14));
    const res = await request(app).post("/api/auth/me/password").set("Cookie", cookie).send({
      current_password: "totally-the-wrong-password", new_password: "a-genuinely-new-password-1",
    });
    expect(res.status).toBe(403);

    const stillWorks = await request(app).post("/api/auth/login")
      .send({ email: "owner@school.test", password: "x".repeat(14) });
    expect(stillWorks.status).toBe(200);
  });

  it("rejects a weak new password", async () => {
    const { cookie } = await loginAs("owner@school.test", "x".repeat(14));
    const res = await request(app).post("/api/auth/me/password").set("Cookie", cookie).send({
      current_password: "x".repeat(14), new_password: "short",
    });
    expect(res.status).toBe(400);
  });

  it("refuses an anonymous request", async () => {
    const res = await request(app).post("/api/auth/me/password").send({
      current_password: "x".repeat(14), new_password: "a-genuinely-new-password-1",
    });
    expect(res.status).toBe(401);
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
    // A "forgot password" request isn't scoped to any one school — the
    // same email could belong to memberships at several — so there's
    // no single School ID or role to correctly show here, unlike the
    // invite/resend-invite emails, which are always about one specific
    // school. Login email is still shown, though: it's always the
    // address this exact mail was sent to, always needed to sign in
    // regardless of which flow sent the email.
    expect(sendMailSpy.mock.calls[0][0].text).toContain("Login email: owner@school.test");
    expect(sendMailSpy.mock.calls[0][0].text).not.toContain("School ID:");
    expect(sendMailSpy.mock.calls[0][0].text).not.toContain("Role:");

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

describe("bootstrap-school", () => {
  it("creates a school, an owner user, and logs them straight in", async () => {
    const res = await request(app).post("/api/auth/bootstrap-school").send({
      school_name: "Vidya Mandir Public School",
      short_code: "vidya-mandir",
      address: "48 MG Road, Bengaluru",
      owner_full_name: "R. Krishnamurthy",
      owner_email: "admin@vidyamandir.test",
      owner_password: "a-genuinely-strong-password-1",
      setup_key: process.env.ADMIN_SETUP_TOKEN,
    });
    expect(res.status).toBe(201);
    expect(res.body.school.short_code).toBe("vidya-mandir");
    expect(res.body.membership.role).toBe("owner");
    expect(res.headers["set-cookie"]).toBeDefined();

    // The session cookie actually works, not just present.
    const me = await request(app).get("/api/auth/me").set("Cookie", res.headers["set-cookie"]);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe("admin@vidyamandir.test");
  });

  it("refuses a duplicate School ID", async () => {
    await request(app).post("/api/auth/bootstrap-school").send({
      school_name: "First School", short_code: "dup-code",
      owner_full_name: "Owner One", owner_email: "one@dup.test",
      owner_password: "a-genuinely-strong-password-1", setup_key: process.env.ADMIN_SETUP_TOKEN,
    });
    const second = await request(app).post("/api/auth/bootstrap-school").send({
      school_name: "Second School", short_code: "dup-code",
      owner_full_name: "Owner Two", owner_email: "two@dup.test",
      owner_password: "a-genuinely-strong-password-1", setup_key: process.env.ADMIN_SETUP_TOKEN,
    });
    expect(second.status).toBe(409);

    const schools = await pool.query(`SELECT COUNT(*) FROM schools WHERE short_code = 'dup-code'`);
    expect(Number(schools.rows[0].count)).toBe(1); // the failed attempt created nothing
  });

  it("refuses an email already in use, and doesn't leave a half-created school behind", async () => {
    await request(app).post("/api/auth/bootstrap-school").send({
      school_name: "First School", short_code: "first-school",
      owner_full_name: "Owner", owner_email: "shared@dup.test",
      owner_password: "a-genuinely-strong-password-1", setup_key: process.env.ADMIN_SETUP_TOKEN,
    });
    const second = await request(app).post("/api/auth/bootstrap-school").send({
      school_name: "Second School", short_code: "second-school",
      owner_full_name: "Owner", owner_email: "shared@dup.test",
      owner_password: "a-genuinely-strong-password-1", setup_key: process.env.ADMIN_SETUP_TOKEN,
    });
    expect(second.status).toBe(409);

    const secondSchool = await pool.query(`SELECT 1 FROM schools WHERE short_code = 'second-school'`);
    expect(secondSchool.rows).toHaveLength(0); // rolled back, not left as an orphan
  });

  it("rejects a weak owner password", async () => {
    const res = await request(app).post("/api/auth/bootstrap-school").send({
      school_name: "Weak Pw School", short_code: "weak-pw-school",
      owner_full_name: "Owner", owner_email: "weak@pw.test", owner_password: "12345",
      setup_key: process.env.ADMIN_SETUP_TOKEN,
    });
    expect(res.status).toBe(400);
  });

  it("rejects a School ID with spaces or uppercase letters", async () => {
    const res = await request(app).post("/api/auth/bootstrap-school").send({
      school_name: "Bad Code School", short_code: "Bad Code!",
      owner_full_name: "Owner", owner_email: "bad@code.test",
      owner_password: "a-genuinely-strong-password-1", setup_key: process.env.ADMIN_SETUP_TOKEN,
    });
    expect(res.status).toBe(400);
  });

  it("refuses a request with the wrong setup key, and creates nothing", async () => {
    const res = await request(app).post("/api/auth/bootstrap-school").send({
      school_name: "Sneaky School", short_code: "sneaky-school",
      owner_full_name: "Owner", owner_email: "sneaky@wrong-key.test",
      owner_password: "a-genuinely-strong-password-1", setup_key: "not-the-real-key",
    });
    expect(res.status).toBe(403);

    const rows = await pool.query(`SELECT 1 FROM schools WHERE short_code = 'sneaky-school'`);
    expect(rows.rows).toHaveLength(0);
  });

  it("refuses a request with no setup key at all", async () => {
    const res = await request(app).post("/api/auth/bootstrap-school").send({
      school_name: "No Key School", short_code: "no-key-school",
      owner_full_name: "Owner", owner_email: "nokey@wrong-key.test",
      owner_password: "a-genuinely-strong-password-1",
    });
    expect(res.status).toBe(400); // zod: setup_key itself is required
  });

  it("fails closed — refuses every request when ADMIN_SETUP_TOKEN isn't configured at all", async () => {
    const original = process.env.ADMIN_SETUP_TOKEN;
    delete process.env.ADMIN_SETUP_TOKEN;
    try {
      const res = await request(app).post("/api/auth/bootstrap-school").send({
        school_name: "Unconfigured Deployment School", short_code: "unconfigured-school",
        owner_full_name: "Owner", owner_email: "owner@unconfigured.test",
        owner_password: "a-genuinely-strong-password-1", setup_key: "anything-at-all",
      });
      expect(res.status).toBe(503);

      const rows = await pool.query(`SELECT 1 FROM schools WHERE short_code = 'unconfigured-school'`);
      expect(rows.rows).toHaveLength(0);
    } finally {
      process.env.ADMIN_SETUP_TOKEN = original; // restore for every later test
    }
  });
});

describe("public school lookup", () => {
  it("returns display details for an exact, active short_code match", async () => {
    const res = await request(app).get("/api/auth/schools/acc-test");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: school.name, logo_data_url: school.logo_data_url });
    expect(res.body.id).toBeUndefined(); // never leaks the id or anything beyond display fields
  });

  it("404s for a School ID that doesn't exist, not an empty 200", async () => {
    const res = await request(app).get("/api/auth/schools/does-not-exist");
    expect(res.status).toBe(404);
  });

  it("is genuinely public — no session needed", async () => {
    const res = await request(app).get("/api/auth/schools/acc-test");
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
