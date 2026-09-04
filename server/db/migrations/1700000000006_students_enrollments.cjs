/**
 * Student is permanent identity only — nothing year-specific lives here.
 * Enrollment is one student in one academic year, and is what everything
 * financial (charges, concessions, payments) hangs off. This split is
 * what makes history, reprints, and year-over-year reporting possible —
 * see the Django design invariants this was ported from.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable("students", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    school_id: { type: "uuid", notNull: true, references: "schools", onDelete: "CASCADE" },
    admission_no: { type: "text", notNull: true },
    full_name: { type: "text", notNull: true },
    date_of_birth: { type: "date" },
    gender: { type: "text", notNull: true, default: "" },
    admitted_on: { type: "date" },
    status: {
      type: "text", notNull: true, default: "active",
      check: "status IN ('active', 'alumni', 'transferred', 'left')",
    },
    // Personal layer — erasable under DPDP once its purpose is served.
    // See server/services/students.ts::deidentify.
    guardian_name: { type: "text", notNull: true, default: "" },
    guardian_phone: { type: "text", notNull: true, default: "" },
    guardian_email: { type: "text", notNull: true, default: "" },
    address: { type: "text", notNull: true, default: "" },
    photo_key: { type: "text", notNull: true, default: "" },
    deidentified_at: { type: "timestamptz" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    created_by: { type: "uuid", references: "users", onDelete: "SET NULL" },
  });
  pgm.addConstraint("students", "uniq_admission_no_per_school",
    { unique: ["school_id", "admission_no"] });
  pgm.createIndex("students", ["school_id", "full_name"]);

  pgm.createTable("enrollments", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    school_id: { type: "uuid", notNull: true, references: "schools", onDelete: "CASCADE" },
    student_id: { type: "uuid", notNull: true, references: "students", onDelete: "RESTRICT" },
    academic_year_id: { type: "uuid", notNull: true, references: "academic_years", onDelete: "RESTRICT" },
    class_level_id: { type: "uuid", notNull: true, references: "class_levels", onDelete: "RESTRICT" },
    section_id: { type: "uuid", notNull: true, references: "sections", onDelete: "RESTRICT" },
    stream_id: { type: "uuid", references: "streams", onDelete: "RESTRICT" },
    roll_no: { type: "smallint" },
    admission_type: {
      type: "text", notNull: true,
      check: "admission_type IN ('new', 'carry_over', 'repeat', 'readmission')",
    },
    outcome: {
      type: "text", notNull: true, default: "pending",
      check: "outcome IN ('pending', 'promoted', 'detained', 'tc_issued', 'passed_out', 'left')",
    },
    promotion_batch_id: { type: "uuid" }, // FK added once promotion_batches exists
    is_active: { type: "boolean", notNull: true, default: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    created_by: { type: "uuid", references: "users", onDelete: "SET NULL" },
  });
  pgm.addConstraint("enrollments", "uniq_enrollment_per_student_year",
    { unique: ["school_id", "student_id", "academic_year_id"] });
  pgm.addConstraint("enrollments", "uniq_roll_no_per_section", {
    unique: ["school_id", "section_id", "roll_no"],
  });
  pgm.createIndex("enrollments", ["school_id", "academic_year_id", "class_level_id"]);

  pgm.createTable("transport_assignments", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    school_id: { type: "uuid", notNull: true, references: "schools", onDelete: "CASCADE" },
    enrollment_id: { type: "uuid", notNull: true, references: "enrollments", onDelete: "RESTRICT" },
    stop_id: { type: "uuid", notNull: true, references: "route_stops", onDelete: "RESTRICT" },
    started_on: { type: "date", notNull: true },
    ended_on: { type: "date" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createIndex("transport_assignments", ["school_id", "stop_id", "ended_on"]);
};

exports.down = (pgm) => {
  pgm.dropTable("transport_assignments");
  pgm.dropTable("enrollments");
  pgm.dropTable("students");
};
