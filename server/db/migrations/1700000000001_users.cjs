exports.shorthands = undefined;

exports.up = (pgm) => {
  // Case-insensitive email column — matches the Django backend's
  // email__iexact lookups without needing LOWER() on every query.
  pgm.createExtension("citext", { ifNotExists: true });

  pgm.createTable("users", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    email: { type: "citext", notNull: true, unique: true },
    // Null until a password is set — an invited user has a row here with
    // no usable password, exactly like the Django version's
    // set_unusable_password(). They can only get one through the same
    // signed reset-link mechanism as everyone else.
    password_hash: { type: "text" },
    full_name: { type: "text", notNull: true, default: "" },
    is_active: { type: "boolean", notNull: true, default: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
};

exports.down = (pgm) => {
  pgm.dropTable("users");
};
