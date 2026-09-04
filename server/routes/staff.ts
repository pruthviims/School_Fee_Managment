import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/index.js";
import { requireCapability } from "../middleware/permissions.js";
import { capabilitiesFor, type Role } from "../permissions.js";
import { makeAndSendCredentialEmail } from "./auth.js";

export const staffRouter = Router();
staffRouter.use(requireCapability("manage_staff"));

const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner", accountant: "Accountant", front_desk: "Front desk", viewer: "Viewer",
};

function serializeMembership(row: any) {
  return {
    id: row.id,
    user_id: row.user_id,
    email: row.email,
    full_name: row.full_name,
    role: row.role,
    is_active: row.is_active,
    capabilities: capabilitiesFor(row.role, row.is_active).sort(),
    created_at: row.created_at,
  };
}

staffRouter.get("/", async (req, res) => {
  const result = await pool.query(
    `SELECT m.id, m.role, m.is_active, m.created_at, m.user_id,
            u.email, u.full_name
     FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.school_id = $1
     ORDER BY u.full_name, u.email`,
    [req.school!.id],
  );
  res.json(result.rows.map(serializeMembership));
});

const inviteSchema = z.object({
  email: z.string().email(),
  full_name: z.string().max(150).optional().default(""),
  role: z.enum(["owner", "accountant", "front_desk", "viewer"]),
});

staffRouter.post("/", async (req, res) => {
  const parsed = inviteSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ detail: parsed.error.issues[0]?.message ?? "Invalid request." });
  }
  const email = parsed.data.email.trim().toLowerCase();
  const { full_name, role } = parsed.data;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let userResult = await client.query(`SELECT * FROM users WHERE email = $1`, [email]);
    let user = userResult.rows[0];
    if (!user) {
      // No usable password until the invite link is used — password_hash
      // stays null, same as the Django version's set_unusable_password().
      const inserted = await client.query(
        `INSERT INTO users (email, full_name) VALUES ($1, $2) RETURNING *`,
        [email, full_name],
      );
      user = inserted.rows[0];
    } else if (full_name && !user.full_name) {
      await client.query(`UPDATE users SET full_name = $1 WHERE id = $2`, [full_name, user.id]);
      user.full_name = full_name;
    }

    const existing = await client.query(
      `SELECT id FROM memberships WHERE user_id = $1 AND school_id = $2`,
      [user.id, req.school!.id],
    );
    if (existing.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(409).json({ detail: "This person already has access to this school." });
    }

    const membership = await client.query(
      `INSERT INTO memberships (user_id, school_id, role, invited_by)
       VALUES ($1, $2, $3, $4) RETURNING id, role, is_active, created_at`,
      [user.id, req.school!.id, role, req.user!.id],
    );

    await client.query("COMMIT");

    await makeAndSendCredentialEmail(user, {
      subject: `You've been added to ${req.school!.name}'s Fee Portal`,
      intro: `${req.user!.full_name || req.user!.email} has given you ` +
        `${ROLE_LABEL[role as Role]} access to ${req.school!.name} on the Fee Portal. ` +
        "Set your password to get started:",
    });

    res.status(201).json(serializeMembership({
      ...membership.rows[0], user_id: user.id, email: user.email, full_name: user.full_name,
    }));
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

const updateSchema = z.object({
  role: z.enum(["owner", "accountant", "front_desk", "viewer"]).optional(),
  is_active: z.boolean().optional(),
}).refine((v) => v.role !== undefined || v.is_active !== undefined, {
  message: "Nothing to update.",
});

async function loadMembership(req: any, membershipId: string) {
  const result = await pool.query(
    `SELECT m.id, m.role, m.is_active, m.created_at, m.user_id, u.email, u.full_name
     FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.id = $1 AND m.school_id = $2`,
    [membershipId, req.school!.id],
  );
  return result.rows[0] ?? null;
}

staffRouter.patch("/:membershipId", async (req, res) => {
  const membership = await loadMembership(req, req.params.membershipId);
  if (!membership) return res.status(404).end();
  if (membership.user_id === req.user!.id) {
    return res.status(400).json({ detail: "You can't change your own access from here." });
  }

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ detail: parsed.error.issues[0]?.message ?? "Invalid request." });
  }

  const fields: string[] = [];
  const values: unknown[] = [];
  if (parsed.data.role !== undefined) {
    values.push(parsed.data.role);
    fields.push(`role = $${values.length}`);
  }
  if (parsed.data.is_active !== undefined) {
    values.push(parsed.data.is_active);
    fields.push(`is_active = $${values.length}`);
  }
  values.push(membership.id);
  await pool.query(`UPDATE memberships SET ${fields.join(", ")} WHERE id = $${values.length}`, values);

  const updated = await loadMembership(req, membership.id);
  res.json(serializeMembership(updated));
});

staffRouter.delete("/:membershipId", async (req, res) => {
  const membership = await loadMembership(req, req.params.membershipId);
  if (!membership) return res.status(404).end();
  if (membership.user_id === req.user!.id) {
    return res.status(400).json({ detail: "You can't change your own access from here." });
  }

  await pool.query(`UPDATE memberships SET is_active = false WHERE id = $1`, [membership.id]);
  res.status(204).end();
});
