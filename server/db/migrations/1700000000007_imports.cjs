/**
 * Staged bulk import — nothing touches students until the admin confirms
 * a clean dry run. See server/services/importer.ts.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable("import_batches", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    school_id: { type: "uuid", notNull: true, references: "schools", onDelete: "CASCADE" },
    academic_year_id: { type: "uuid", notNull: true, references: "academic_years", onDelete: "RESTRICT" },
    filename: { type: "text", notNull: true },
    column_map: { type: "jsonb", notNull: true, default: "{}" },
    status: {
      type: "text", notNull: true, default: "uploaded",
      check: "status IN ('uploaded', 'validated', 'committed', 'cancelled')",
    },
    total_rows: { type: "integer", notNull: true, default: 0 },
    valid_rows: { type: "integer", notNull: true, default: 0 },
    committed_at: { type: "timestamptz" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    created_by: { type: "uuid", references: "users", onDelete: "SET NULL" },
  });

  pgm.createTable("import_rows", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    school_id: { type: "uuid", notNull: true, references: "schools", onDelete: "CASCADE" },
    batch_id: { type: "uuid", notNull: true, references: "import_batches", onDelete: "CASCADE" },
    line_no: { type: "integer", notNull: true },
    raw: { type: "jsonb", notNull: true, default: "{}" },
    errors: { type: "jsonb", notNull: true, default: "[]" },
    warnings: { type: "jsonb", notNull: true, default: "[]" },
    student_id: { type: "uuid", references: "students", onDelete: "SET NULL" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createIndex("import_rows", ["batch_id", "line_no"]);
};

exports.down = (pgm) => {
  pgm.dropTable("import_rows");
  pgm.dropTable("import_batches");
};
