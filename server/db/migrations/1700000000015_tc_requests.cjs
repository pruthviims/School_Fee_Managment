/**
 * Any student leaving the school for any reason — a family relocating,
 * a transfer to another school, anything — goes through the same
 * process and ends in a TC (confirmed: even a casual relocation still
 * needs one, there's no separate "just withdraw, no TC" path anymore).
 *
 * Three stages, tracked explicitly rather than folded into a single
 * action, so there's always a real record of who cleared dues and
 * when versus who actually issued the certificate and when — even
 * when it's the same person doing both back to back (confirmed:
 * Accountant can complete the whole flow alone, this isn't a hard
 * two-person requirement, but the two steps still get their own
 * timestamp and actor each):
 *   pending_clearance -> cleared -> issued
 *
 * tc_number follows the same sequential-and-gapless pattern already
 * used for receipts (see document_counters / documentCounter.ts) —
 * added as a new doc_type rather than inventing a separate mechanism.
 *
 * conduct, qualified_for_promotion, and remarks are captured here, at
 * issuance, rather than added to the student record permanently —
 * they're TC-specific attestations, not everyday student data, and
 * nothing else in the app needs them before a student is actually
 * leaving.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable("tc_requests", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    school_id: { type: "uuid", notNull: true, references: "schools", onDelete: "CASCADE" },
    enrollment_id: { type: "uuid", notNull: true, references: "enrollments", onDelete: "RESTRICT" },
    status: {
      type: "text", notNull: true, default: "pending_clearance",
      check: "status IN ('pending_clearance', 'cleared', 'issued')",
    },
    reason: { type: "text", notNull: true, default: "" },
    last_day: { type: "date", notNull: true },
    requested_by: { type: "uuid", references: "users", onDelete: "SET NULL" },
    requested_on: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    clearance_note: { type: "text", notNull: true, default: "" },
    cleared_by: { type: "uuid", references: "users", onDelete: "SET NULL" },
    cleared_on: { type: "timestamptz" },
    tc_number: { type: "text" },
    conduct: { type: "text", notNull: true, default: "" },
    qualified_for_promotion: { type: "boolean" },
    remarks: { type: "text", notNull: true, default: "" },
    issued_by: { type: "uuid", references: "users", onDelete: "SET NULL" },
    issued_on: { type: "timestamptz" },
  });
  pgm.createIndex("tc_requests", ["school_id", "enrollment_id"]);

  pgm.dropConstraint("document_counters", "document_counters_doc_type_check");
  pgm.addConstraint("document_counters", "document_counters_doc_type_check",
    { check: "doc_type IN ('receipt', 'invoice', 'tc')" });
};

exports.down = (pgm) => {
  pgm.dropConstraint("document_counters", "document_counters_doc_type_check");
  pgm.addConstraint("document_counters", "document_counters_doc_type_check",
    { check: "doc_type IN ('receipt', 'invoice')" });
  pgm.dropTable("tc_requests");
};
