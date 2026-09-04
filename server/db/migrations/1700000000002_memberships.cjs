/**
 * One row per (user, school): what that person can do there. A user with
 * no row here for a school has no access to it at all — see
 * server/permissions.ts for how ROLE_CAPABILITIES turns `role` into what
 * an API request is actually allowed to do.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable("memberships", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    user_id: {
      type: "uuid", notNull: true,
      references: "users", onDelete: "CASCADE",
    },
    school_id: {
      type: "uuid", notNull: true,
      references: "schools", onDelete: "CASCADE",
    },
    role: {
      type: "text", notNull: true,
      check: "role IN ('owner', 'accountant', 'front_desk', 'viewer')",
    },
    is_active: { type: "boolean", notNull: true, default: true },
    invited_by: {
      type: "uuid",
      references: "users", onDelete: "SET NULL",
    },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint("memberships", "uniq_membership_per_user_school", {
    unique: ["user_id", "school_id"],
  });
};

exports.down = (pgm) => {
  pgm.dropTable("memberships");
};
