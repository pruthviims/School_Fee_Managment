/**
 * Adds the review layer this app was missing: TC requests could already
 * be approved (the existing 'cleared' status), but never explicitly
 * rejected — this adds that as a real terminal status alongside it,
 * with its own actor/timestamp/comments, the same shape 'cleared'
 * already has. Refunds have no equivalent at all: creating one has
 * always required void_payments directly, so there was never a
 * "pending, awaiting approval" state to represent in the first place.
 *
 * refund_requests is a new, small table rather than adding a status
 * column to the existing refunds table — deliberately, since refunds
 * is the completed-transaction ledger a pending request must never be
 * mixed into (a pending request has no financial effect at all; a row
 * in `refunds` always does). refund_id is filled in only once a
 * request is actually approved and the existing, unmodified refund
 * logic creates the real transaction — the request row and the refund
 * row stay two different things, linked, not merged.
 */
exports.up = (pgm) => {
  pgm.dropConstraint("tc_requests", "tc_requests_status_check");
  pgm.addConstraint("tc_requests", "tc_requests_status_check",
    { check: "status IN ('pending_clearance', 'cleared', 'issued', 'rejected')" });
  pgm.addColumns("tc_requests", {
    rejected_by: { type: "uuid", references: "users" },
    rejected_on: { type: "timestamptz" },
    rejection_comments: { type: "text" },
  });

  pgm.createTable("refund_requests", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    school_id: { type: "uuid", notNull: true, references: "schools" },
    enrollment_id: { type: "uuid", notNull: true, references: "enrollments" },
    amount: { type: "bigint", notNull: true },
    mode: { type: "text", notNull: true },
    instrument_ref: { type: "text", notNull: true, default: "" },
    reason: { type: "text", notNull: true, default: "" },
    status: { type: "text", notNull: true, default: "pending",
      check: "status IN ('pending', 'approved', 'rejected')" },
    requested_by: { type: "uuid", references: "users" },
    requested_on: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    reviewed_by: { type: "uuid", references: "users" },
    reviewed_on: { type: "timestamptz" },
    rejection_comments: { type: "text" },
    approval_comments: { type: "text" },
    // Set only once approval actually creates the real transaction —
    // the request itself never touches the ledger before this exists.
    refund_id: { type: "uuid", references: "refunds" },
  });
  pgm.createIndex("refund_requests", ["school_id", "status"]);
  pgm.createIndex("refund_requests", ["enrollment_id"]);
};

exports.down = (pgm) => {
  pgm.dropTable("refund_requests");
  pgm.dropColumns("tc_requests", ["rejected_by", "rejected_on", "rejection_comments"]);
  pgm.dropConstraint("tc_requests", "tc_requests_status_check");
  pgm.addConstraint("tc_requests", "tc_requests_status_check",
    { check: "status IN ('pending_clearance', 'cleared', 'issued')" });
};
