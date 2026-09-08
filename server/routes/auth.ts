import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/index.js";
import { SESSION_COOKIE } from "../middleware/auth.js";
import { requireAuth } from "../middleware/permissions.js";
import { capabilitiesFor } from "../permissions.js";
import {
  CREDENTIAL_TOKEN_TTL_HOURS,
  checkCredentialToken,
  hashPassword,
  issueSessionToken,
  makeCredentialToken,
  verifyPassword,
} from "../services/authService.js";
import { sendMail } from "../services/emailService.js";

export const authRouter = Router();

const isProd = process.env.NODE_ENV === "production";
const cookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: "lax" as const,
  maxAge: 1000 * 60 * 60 * 8, // 8h, matches the JWT's own expiry
};

function meResponse(
  user: { id: string; email: string; full_name: string },
  membership: { id: string; role: string; is_active: boolean } | null,
  school: { id: string; name: string; short_code: string; address: string;
            logo_key: string; logo_data_url: string; receipt_footer: string } | null,
) {
  return {
    id: user.id,
    email: user.email,
    full_name: user.full_name,
    school: school && {
      id: school.id, name: school.name, short_code: school.short_code,
      address: school.address, logo_key: school.logo_key,
      logo_data_url: school.logo_data_url, receipt_footer: school.receipt_footer,
    },
    membership: membership && {
      id: membership.id,
      role: membership.role,
      is_active: membership.is_active,
      capabilities: capabilitiesFor(membership.role as never, membership.is_active).sort(),
    },
  };
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ detail: "Enter an email and password." });
  const { email, password } = parsed.data;

  const userResult = await pool.query(
    `SELECT id, email, full_name, is_active, password_hash FROM users WHERE email = $1`,
    [email],
  );
  const user = userResult.rows[0];
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return res.status(401).json({ detail: "Incorrect email or password." });
  }
  if (!user.is_active) {
    return res.status(403).json({ detail: "This account has been deactivated." });
  }

  const membershipResult = await pool.query(
    `SELECT m.id, m.role, m.is_active,
            s.id AS school_id, s.name, s.short_code, s.address, s.logo_key, s.logo_data_url, s.receipt_footer
     FROM memberships m JOIN schools s ON s.id = m.school_id
     WHERE m.user_id = $1 AND m.is_active = true AND s.is_active = true
     ORDER BY m.created_at ASC LIMIT 1`,
    [user.id],
  );
  const row = membershipResult.rows[0];
  if (!row) {
    return res.status(403).json({ detail: "This account has no active school to sign in to." });
  }
  const membership = { id: row.id, role: row.role, is_active: row.is_active };
  const school = { id: row.school_id, name: row.name, short_code: row.short_code,
    address: row.address, logo_key: row.logo_key, logo_data_url: row.logo_data_url,
    receipt_footer: row.receipt_footer };

  const token = issueSessionToken(user.id);
  res.cookie(SESSION_COOKIE, token, cookieOptions);
  res.json(meResponse(user, membership, school));
});

authRouter.post("/logout", requireAuth, (_req, res) => {
  res.clearCookie(SESSION_COOKIE);
  res.status(204).end();
});

authRouter.get("/me", requireAuth, (req, res) => {
  res.json(meResponse(req.user!, req.membership ?? null, req.school ?? null));
});

authRouter.get("/schools/:shortCode", async (req, res) => {
  // Deliberately public and deliberately narrow: exact short_code lookup
  // only (never a search or a list), returning nothing but display
  // details — no id, no counts, nothing that helps enumerate or profile
  // a school. This exists for the login screen's live "does this School
  // ID match a real school" preview as the office types it in.
  const result = await pool.query(
    `SELECT name, logo_data_url FROM schools WHERE short_code = $1 AND is_active = true`,
    [String(req.params.shortCode).toLowerCase()],
  );
  const school = result.rows[0];
  if (!school) return res.status(404).json({ detail: "No school with that ID." });
  res.json({ name: school.name, logo_data_url: school.logo_data_url });
});

const bootstrapSchema = z.object({
  school_name: z.string().min(1).max(200),
  short_code: z.string().min(2).max(20)
    .regex(/^[a-z0-9-]+$/, "Use lowercase letters, numbers, and hyphens only."),
  address: z.string().max(500).optional().default(""),
  owner_full_name: z.string().min(1).max(150),
  owner_email: z.string().email(),
  owner_password: z.string().min(12, "Use at least 12 characters."),
  setup_key: z.string().min(1, "Enter the setup key."),
});

// Constant-time comparison, avoiding the length check itself leaking
// timing information about how close a guess was character-by-character
// — crypto.timingSafeEqual requires equal-length buffers, so unequal
// lengths are padded to match before comparing rather than short-
// circuited, which would otherwise leak the correct key's length.
function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  const len = Math.max(aBuf.length, bBuf.length, 1);
  const aPadded = Buffer.alloc(len);
  const bPadded = Buffer.alloc(len);
  aBuf.copy(aPadded);
  bBuf.copy(bPadded);
  return crypto.timingSafeEqual(aPadded, bPadded) && aBuf.length === bBuf.length;
}

/**
 * Self-serve: create a brand-new school and its first (owner) user in one
 * transaction, then sign them straight in. Everything after this point —
 * inviting more staff, setting up fee structure — goes through the
 * normal authenticated routes; this is the one unauthenticated door in,
 * matching what the frontend's Setup screen needs.
 */
authRouter.post("/bootstrap-school", async (req, res) => {
  const parsed = bootstrapSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ detail: parsed.error.issues[0]?.message });
  const d = parsed.data;

  // Public, unauthenticated door — without this, anyone who finds the
  // URL could create unlimited schools on this deployment. Fails closed:
  // an operator who forgets to set ADMIN_SETUP_TOKEN gets setup refused
  // outright, not a silently-open endpoint.
  const expectedKey = process.env.ADMIN_SETUP_TOKEN;
  if (!expectedKey) {
    return res.status(503).json({
      detail: "School setup isn't enabled on this deployment yet. Ask whoever manages it to set ADMIN_SETUP_TOKEN.",
    });
  }
  if (!safeEqual(d.setup_key, expectedKey)) {
    return res.status(403).json({ detail: "That setup key is incorrect." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let school;
    try {
      const schoolResult = await client.query(
        `INSERT INTO schools (name, short_code, address) VALUES ($1, $2, $3) RETURNING *`,
        [d.school_name, d.short_code, d.address],
      );
      school = schoolResult.rows[0];
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        await client.query("ROLLBACK");
        return res.status(409).json({ detail: "That School ID is already taken." });
      }
      throw err;
    }

    let user;
    try {
      const passwordHash = await hashPassword(d.owner_password);
      const userResult = await client.query(
        `INSERT INTO users (email, full_name, password_hash) VALUES ($1, $2, $3) RETURNING *`,
        [d.owner_email.toLowerCase(), d.owner_full_name, passwordHash],
      );
      user = userResult.rows[0];
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        await client.query("ROLLBACK");
        return res.status(409).json({
          detail: "An account already exists with that email. Sign in instead, or use a different email.",
        });
      }
      throw err;
    }

    const membershipResult = await client.query(
      `INSERT INTO memberships (user_id, school_id, role) VALUES ($1, $2, 'owner') RETURNING *`,
      [user.id, school.id],
    );
    const membership = membershipResult.rows[0];

    await client.query("COMMIT");

    const token = issueSessionToken(user.id);
    res.cookie(SESSION_COOKIE, token, cookieOptions);
    res.status(201).json(meResponse(user, membership, school));
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

const resetRequestSchema = z.object({ email: z.string().email() });

authRouter.post("/password-reset", async (req, res) => {
  const parsed = resetRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ detail: "Enter an email address." });

  const result = await pool.query(
    `SELECT id, password_hash, email FROM users WHERE email = $1 AND is_active = true`,
    [parsed.data.email],
  );
  const user = result.rows[0];
  if (user) {
    await makeAndSendCredentialEmail(user, {
      subject: "Reset your Fee Portal password",
      intro: "Someone asked to reset the password on this account. " +
             "If this was you, set a new password here:",
    });
  }
  // Identical response either way — never reveal whether the address exists.
  res.json({ detail: "If that email has an account, a reset link has been sent." });
});

const resetConfirmSchema = z.object({
  uid: z.string(),
  token: z.string(),
  new_password: z.string().min(12, "Use at least 12 characters."),
});

authRouter.post("/password-reset/confirm", async (req, res) => {
  const parsed = resetConfirmSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ detail: parsed.error.issues[0]?.message ?? "Invalid request." });
  }
  const { uid, token, new_password } = parsed.data;

  const result = await pool.query(
    `SELECT id, password_hash FROM users WHERE id = $1`, [uid],
  );
  const user = result.rows[0];
  if (!user || !checkCredentialToken(user, token)) {
    return res.status(400).json({ detail: "This reset link is invalid or has expired." });
  }

  const hash = await hashPassword(new_password);
  await pool.query(`UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`,
    [hash, user.id]);
  res.json({ detail: "Password updated. You can sign in now." });
});

export async function makeAndSendCredentialEmail(
  user: { id: string; password_hash: string | null; email: string },
  { subject, intro }: { subject: string; intro: string },
) {
  const token = makeCredentialToken(user);
  const uid = user.id;
  const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "");
  const resetUrl = `${frontendUrl}/reset-password?uid=${uid}&token=${token}`;

  await sendMail({
    to: user.email,
    subject,
    text: `${intro}\n\n${resetUrl}\n\n` +
      `This link works for ${CREDENTIAL_TOKEN_TTL_HOURS} hours. If you didn't expect this ` +
      "email, you can ignore it — nothing changes until the link is used.",
  });
}
