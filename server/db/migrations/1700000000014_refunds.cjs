/**
 * A student may stop attending mid-year — a parent's death, a transfer
 * to another school, a family relocating. enrollments.outcome already
 * had a 'left' value with nowhere that ever set it; this adds the two
 * fields withdrawing a student actually needs recorded (when, and
 * why), and a genuinely separate refunds table for the money side.
 *
 * refunds deliberately mirrors payments in shape rather than being
 * modeled as a negative payment or an allocation reversal — a refund
 * is management's own decision about an amount to hand back, not
 * something derived from the ledger math (confirmed: free-form amount,
 * not capped to any calculated credit). approver_name is free text,
 * the same pattern already used on concessions, for the same reason:
 * whoever in management approved it may not have (or need) their own
 * login here.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns("enrollments", {
    withdrawn_on: { type: "date" },
    withdrawal_reason: { type: "text" },
  });

  pgm.createTable("refunds", {
    id: { type: "uuid", default: pgm.func("gen_random_uuid()"), primaryKey: true },
    school_id: { type: "uuid", notNull: true, references: "schools", onDelete: "CASCADE" },
    enrollment_id: { type: "uuid", notNull: true, references: "enrollments", onDelete: "RESTRICT" },
    amount: { type: "bigint", notNull: true }, // paise
    mode: {
      type: "text", notNull: true,
      check: "mode IN ('cash', 'upi', 'card', 'netbanking', 'neft', 'cheque', 'dd')",
    },
    instrument_ref: { type: "text", notNull: true, default: "" },
    reason: { type: "text", notNull: true, default: "" },
    approver_name: { type: "text", notNull: true, default: "" },
    refunded_by: { type: "uuid", references: "users", onDelete: "SET NULL" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.createIndex("refunds", ["school_id", "enrollment_id"]);
};

exports.down = (pgm) => {
  pgm.dropTable("refunds");
  pgm.dropColumns("enrollments", ["withdrawn_on", "withdrawal_reason"]);
};
