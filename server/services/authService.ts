/**
 * Everything credential-related in one place: password hashing (bcrypt),
 * session tokens (JWT, carried in an httpOnly cookie), and password-reset
 * / staff-invite tokens.
 *
 * The reset token deliberately isn't stored anywhere. It's an HMAC over
 * the user's id, their current password hash, and an expiry timestamp,
 * signed with a server secret — the same design as Django's
 * PasswordResetTokenGenerator, ported rather than replaced with a
 * database table, for the same reason: including the password hash means
 * the token is automatically invalidated the moment the password changes
 * or the expiry passes, with nothing to store and nothing to clean up.
 */

import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";

const RESET_TOKEN_TTL_MS = Number(process.env.PASSWORD_RESET_TIMEOUT_MS) || 1000 * 60 * 60 * 24; // 24h
const SESSION_TTL = "8h"; // an office shift

export interface AuthUser {
  id: string;
  password_hash: string | null;
}

function requireSecret(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Generate one (e.g. \`openssl rand -hex 32\`) and set it ` +
      "in your environment — see .env.example."
    );
  }
  return value;
}

// --- Passwords ---

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(plain: string, hash: string | null): Promise<boolean> {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

// --- Session tokens (JWT) ---

export interface SessionPayload {
  sub: string; // user id
}

export function issueSessionToken(userId: string): string {
  return jwt.sign({ sub: userId }, requireSecret("JWT_SECRET"), { expiresIn: SESSION_TTL });
}

export function verifySessionToken(token: string): SessionPayload | null {
  try {
    const decoded = jwt.verify(token, requireSecret("JWT_SECRET"));
    if (typeof decoded === "object" && decoded && "sub" in decoded) {
      return { sub: String((decoded as jwt.JwtPayload).sub) };
    }
    return null;
  } catch {
    return null;
  }
}

// --- Password reset / staff invite tokens (stateless, HMAC-signed) ---

function sign(userId: string, passwordHash: string | null, expiresAt: number, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${userId}:${passwordHash ?? ""}:${expiresAt}`)
    .digest("base64url");
}

export function makeCredentialToken(user: AuthUser): string {
  const secret = requireSecret("JWT_SECRET");
  const expiresAt = Date.now() + RESET_TOKEN_TTL_MS;
  const sig = sign(user.id, user.password_hash, expiresAt, secret);
  return `${expiresAt}.${sig}`;
}

export function checkCredentialToken(user: AuthUser, token: string): boolean {
  const secret = requireSecret("JWT_SECRET");
  const [expiresAtRaw, sig] = token.split(".");
  const expiresAt = Number(expiresAtRaw);
  if (!expiresAt || !sig || Number.isNaN(expiresAt) || Date.now() > expiresAt) return false;

  const expected = sign(user.id, user.password_hash, expiresAt, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export const CREDENTIAL_TOKEN_TTL_HOURS = RESET_TOKEN_TTL_MS / (1000 * 60 * 60);
