/**
 * The published price list. Charges are snapshotted FROM this at
 * enrollment (see server/services/billing.ts) — editing a fee_structures
 * row must never retroactively alter a bill already issued. Money is
 * always integer paise (bigint), never float, matching the Django
 * design's explicit invariant.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable("fee_heads", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    school_id: { type: "uuid", notNull: true, references: "schools", onDelete: "CASCADE" },
    name: { type: "text", notNull: true }, // "Tuition fee"
    basis: {
      type: "text", notNull: true, default: "per_class",
      check: "basis IN ('per_class', 'per_slab', 'flat')",
    },
    is_one_time: { type: "boolean", notNull: true, default: false },
    is_optional: { type: "boolean", notNull: true, default: false },
    is_refundable: { type: "boolean", notNull: true, default: false },
    display_order: { type: "smallint", notNull: true, default: 0 },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint("fee_heads", "uniq_fee_head_per_school", { unique: ["school_id", "name"] });

  pgm.createTable("fee_structures", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    school_id: { type: "uuid", notNull: true, references: "schools", onDelete: "CASCADE" },
    academic_year_id: { type: "uuid", notNull: true, references: "academic_years", onDelete: "RESTRICT" },
    class_level_id: { type: "uuid", notNull: true, references: "class_levels", onDelete: "RESTRICT" },
    fee_head_id: { type: "uuid", notNull: true, references: "fee_heads", onDelete: "RESTRICT" },
    stream_id: { type: "uuid", references: "streams", onDelete: "RESTRICT" },
    amount: { type: "bigint", notNull: true }, // paise
    term_no: { type: "smallint", notNull: true, default: 1 },
    due_on: { type: "date", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint("fee_structures", "uniq_fee_structure_line", {
    unique: ["school_id", "academic_year_id", "class_level_id", "fee_head_id", "stream_id", "term_no"],
  });
  pgm.addConstraint("fee_structures", "fee_structure_amount_non_negative", { check: '"amount" >= 0' });
};

exports.down = (pgm) => {
  pgm.dropTable("fee_structures");
  pgm.dropTable("fee_heads");
};
