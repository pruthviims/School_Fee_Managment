/**
 * A systematic audit (every foreign key column, checked against
 * pg_index for whether it leads any existing index) found 53 foreign
 * keys with no index backing them at all — Postgres never creates one
 * automatically the way some other databases do. Most of those are
 * "who did this" audit columns (created_by, approved_by, invited_by,
 * ...) that are essentially never filtered on independently, so
 * indexing them would just slow down writes for no real benefit.
 *
 * These are the ones actually confirmed, by reading the real queries
 * throughout the app, to be used as WHERE/JOIN filters — the same
 * "given a student, find their related records" shape that showed up
 * missing on concessions/allocations in an earlier, narrower fix
 * (1700000000016), just not caught everywhere at the time.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createIndex("enrollments", ["academic_year_id"]);
  pgm.createIndex("enrollments", ["class_level_id"]);
  pgm.createIndex("enrollments", ["student_id"]);
  pgm.createIndex("enrollments", ["promotion_batch_id"]);
  pgm.createIndex("fee_structures", ["academic_year_id"]);
  pgm.createIndex("fee_structures", ["class_level_id"]);
  pgm.createIndex("payments", ["enrollment_id"]);
  pgm.createIndex("sections", ["academic_year_id"]);
  pgm.createIndex("sections", ["class_level_id"]);
  pgm.createIndex("import_rows", ["student_id"]);
  pgm.createIndex("tc_requests", ["enrollment_id"]);
  pgm.createIndex("refunds", ["enrollment_id"]);
  pgm.createIndex("transport_assignments", ["enrollment_id"]);
  pgm.createIndex("invoices", ["enrollment_id"]);
};

exports.down = (pgm) => {
  pgm.dropIndex("invoices", ["enrollment_id"]);
  pgm.dropIndex("transport_assignments", ["enrollment_id"]);
  pgm.dropIndex("refunds", ["enrollment_id"]);
  pgm.dropIndex("tc_requests", ["enrollment_id"]);
  pgm.dropIndex("import_rows", ["student_id"]);
  pgm.dropIndex("sections", ["class_level_id"]);
  pgm.dropIndex("sections", ["academic_year_id"]);
  pgm.dropIndex("payments", ["enrollment_id"]);
  pgm.dropIndex("fee_structures", ["class_level_id"]);
  pgm.dropIndex("fee_structures", ["academic_year_id"]);
  pgm.dropIndex("enrollments", ["promotion_batch_id"]);
  pgm.dropIndex("enrollments", ["student_id"]);
  pgm.dropIndex("enrollments", ["class_level_id"]);
  pgm.dropIndex("enrollments", ["academic_year_id"]);
};
