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

function meResponse(user: { id: string; email: string; full_name: string },
                     membership: { id: string; role: string; is_active: boolean } | null) {
  return {
    id: user.id,
    email: user.email,
    full_name: user.full_name,
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
    `SELECT m.id, m.role, m.is_active
     FROM memberships m JOIN schools s ON s.id = m.school_id
     WHERE m.user_id = $1 AND m.is_active = true AND s.is_active = true
     ORDER BY m.created_at ASC LIMIT 1`,
    [user.id],
  );
  const membership = membershipResult.rows[0] ?? null;
  if (!membership) {
    return res.status(403).json({ detail: "This account has no active school to sign in to." });
  }

  const token = issueSessionToken(user.id);
  res.cookie(SESSION_COOKIE, token, cookieOptions);
  res.json(meResponse(user, membership));
});

authRouter.post("/logout", requireAuth, (_req, res) => {
  res.clearCookie(SESSION_COOKIE);
  res.status(204).end();
});

authRouter.get("/me", requireAuth, (req, res) => {
  res.json(meResponse(req.user!, req.membership ?? null));
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
