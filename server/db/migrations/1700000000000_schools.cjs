/**
 * Minimal School shape — enough for Membership to reference and for the
 * accounts/auth slice to work end to end. The full fee/billing schema
 * (academic years, students, invoices, payments, ...) is a later
 * migration, ported from the Django backend's fees.models the same way
 * this one was ported from fees.models.School.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createExtension("pgcrypto", { ifNotExists: true });

  pgm.createTable("schools", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    name: { type: "text", notNull: true },
    short_code: { type: "text", notNull: true, unique: true },
    address: { type: "text", notNull: true, default: "" },
    logo_key: { type: "text", notNull: true, default: "" },
    receipt_footer: {
      type: "text",
      notNull: true,
      default: "Education services are exempt from GST. This is a computer generated receipt.",
    },
    is_active: { type: "boolean", notNull: true, default: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
};

exports.down = (pgm) => {
  pgm.dropTable("schools");
};
