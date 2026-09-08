import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/index.js";
import { requireCapability } from "../middleware/permissions.js";

export const schoolRouter = Router();

// Stored directly in the database (schools.logo_data_url), not in
// separate object storage — the deliberate choice for a self-hosted,
// single-(or few-)school deployment: one small, rarely-changed image
// per school isn't worth a whole extra storage service and the account/
// token/configuration that comes with it. Owner-only: branding affects
// every screen and every receipt, closer to a school-identity decision
// than day-to-day admin work.
const MAX_LOGO_BYTES = 500 * 1024; // matches the frontend's own stated limit

const logoSchema = z.object({
  logo_data_url: z.string(),
});

schoolRouter.patch("/logo", requireCapability("manage_staff"), async (req, res) => {
  const parsed = logoSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ detail: parsed.error.issues[0]?.message });
  const { logo_data_url } = parsed.data;

  // Empty string is the explicit "remove the logo" case.
  if (logo_data_url !== "") {
    if (!/^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,/.test(logo_data_url)) {
      return res.status(400).json({ detail: "That doesn't look like an image file." });
    }
    // Rough but sufficient: base64 is ~4/3 the size of the original
    // bytes, and this only needs to catch someone bypassing the
    // frontend's own check, not be byte-exact.
    const approxBytes = (logo_data_url.length * 3) / 4;
    if (approxBytes > MAX_LOGO_BYTES) {
      return res.status(400).json({ detail: "Keep the logo under 500KB." });
    }
  }

  const result = await pool.query(
    `UPDATE schools SET logo_data_url = $1, updated_at = now() WHERE id = $2 RETURNING logo_data_url`,
    [logo_data_url, req.school!.id],
  );
  res.json({ logo_data_url: result.rows[0].logo_data_url });
});
