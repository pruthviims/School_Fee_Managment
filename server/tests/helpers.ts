import { pool } from "../db/index.js";
import { hashPassword } from "../services/authService.js";

export async function resetDb() {
  await pool.query("TRUNCATE memberships, users, schools RESTART IDENTITY CASCADE");
}

export async function createSchool(overrides: Partial<{ name: string; short_code: string }> = {}) {
  const result = await pool.query(
    `INSERT INTO schools (name, short_code) VALUES ($1, $2) RETURNING *`,
    [overrides.name ?? "Test School", overrides.short_code ?? `test-${Date.now()}-${Math.random()}`],
  );
  return result.rows[0];
}

export async function createUser(email: string, password: string, fullName = "") {
  const hash = await hashPassword(password);
  const result = await pool.query(
    `INSERT INTO users (email, password_hash, full_name) VALUES ($1, $2, $3) RETURNING *`,
    [email, hash, fullName],
  );
  return result.rows[0];
}

export async function createMembership(
  userId: string, schoolId: string, role: string, isActive = true,
) {
  const result = await pool.query(
    `INSERT INTO memberships (user_id, school_id, role, is_active)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [userId, schoolId, role, isActive],
  );
  return result.rows[0];
}
