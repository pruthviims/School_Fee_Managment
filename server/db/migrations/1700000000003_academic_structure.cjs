/**
 * Academic structure. class_levels.ladder_order is the entire promotion
 * mechanism: promoting a student means finding the level with
 * ladder_order + 1 — see server/services/promotion.ts.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable("academic_years", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    school_id: { type: "uuid", notNull: true, references: "schools", onDelete: "CASCADE" },
    name: { type: "text", notNull: true }, // "2026-27"
    starts_on: { type: "date", notNull: true },
    ends_on: { type: "date", notNull: true },
    status: {
      type: "text", notNull: true, default: "planning",
      check: "status IN ('planning', 'active', 'closed')",
    },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    created_by: { type: "uuid", references: "users", onDelete: "SET NULL" },
  });
  pgm.addConstraint("academic_years", "uniq_year_per_school", { unique: ["school_id", "name"] });
  pgm.addConstraint("academic_years", "year_ends_after_start", { check: '"ends_on" > "starts_on"' });

  pgm.createTable("class_levels", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    school_id: { type: "uuid", notNull: true, references: "schools", onDelete: "CASCADE" },
    name: { type: "text", notNull: true }, // "VIII", "1st PUC"
    ladder_order: { type: "smallint", notNull: true },
    stage: {
      type: "text", notNull: true,
      check: "stage IN ('pre_primary', 'primary', 'middle', 'secondary', 'puc')",
    },
    requires_explicit_optin: { type: "boolean", notNull: true, default: false },
    requires_stream: { type: "boolean", notNull: true, default: false },
    is_terminal: { type: "boolean", notNull: true, default: false },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint("class_levels", "uniq_ladder_order_per_school",
    { unique: ["school_id", "ladder_order"] });
  pgm.addConstraint("class_levels", "uniq_class_name_per_school",
    { unique: ["school_id", "name"] });

  pgm.createTable("streams", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    school_id: { type: "uuid", notNull: true, references: "schools", onDelete: "CASCADE" },
    name: { type: "text", notNull: true }, // "Science"
    combination: { type: "text", notNull: true, default: "" }, // "PCMB"
    applies_to_stage: { type: "text", notNull: true, default: "puc" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint("streams", "uniq_stream_per_school",
    { unique: ["school_id", "name", "combination"] });

  pgm.createTable("sections", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    school_id: { type: "uuid", notNull: true, references: "schools", onDelete: "CASCADE" },
    academic_year_id: { type: "uuid", notNull: true, references: "academic_years", onDelete: "RESTRICT" },
    class_level_id: { type: "uuid", notNull: true, references: "class_levels", onDelete: "RESTRICT" },
    name: { type: "text", notNull: true }, // "A"
    capacity: { type: "smallint", notNull: true, default: 40 },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint("sections", "uniq_section_per_class_year",
    { unique: ["school_id", "academic_year_id", "class_level_id", "name"] });
};

exports.down = (pgm) => {
  pgm.dropTable("sections");
  pgm.dropTable("streams");
  pgm.dropTable("class_levels");
  pgm.dropTable("academic_years");
};
