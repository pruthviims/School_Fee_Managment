/**
 * Append-only. A wrong row is never mutated or deleted — it gets a
 * reversing row via reversed_by, and both stay visible to an auditor.
 * balance is always derived (charged - conceded - cleared payments),
 * never stored as a mutable column — see server/services/ledger.ts.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable("invoices", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    school_id: { type: "uuid", notNull: true, references: "schools", onDelete: "CASCADE" },
    invoice_no: { type: "text", notNull: true },
    enrollment_id: { type: "uuid", notNull: true, references: "enrollments", onDelete: "RESTRICT" },
    issued_on: { type: "date", notNull: true, default: pgm.func("current_date") },
    due_on: { type: "date", notNull: true },
    // Frozen for lawful reprint after a student record is de-identified.
    student_name_at_issue: { type: "text", notNull: true },
    class_at_issue: { type: "text", notNull: true },
    pdf_key: { type: "text", notNull: true, default: "" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    created_by: { type: "uuid", references: "users", onDelete: "SET NULL" },
  });
  pgm.addConstraint("invoices", "uniq_invoice_no_per_school", { unique: ["school_id", "invoice_no"] });

  pgm.createTable("charges", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    school_id: { type: "uuid", notNull: true, references: "schools", onDelete: "CASCADE" },
    enrollment_id: { type: "uuid", notNull: true, references: "enrollments", onDelete: "RESTRICT" },
    fee_head_id: { type: "uuid", references: "fee_heads", onDelete: "RESTRICT" },
    // Frozen label: the head may be renamed later, the historical bill must not change.
    head_name: { type: "text", notNull: true },
    amount: { type: "bigint", notNull: true }, // paise
    term_no: { type: "smallint", notNull: true, default: 1 },
    due_on: { type: "date", notNull: true },
    source: {
      type: "text", notNull: true, default: "structure",
      check: "source IN ('structure', 'arrear', 'manual')",
    },
    is_arrear: { type: "boolean", notNull: true, default: false },
    source_year_id: { type: "uuid", references: "academic_years", onDelete: "RESTRICT" },
    invoice_id: { type: "uuid", references: "invoices", onDelete: "RESTRICT" },
    reversed_by: { type: "uuid", references: "charges", onDelete: "RESTRICT" },
    reversal_reason: { type: "text", notNull: true, default: "" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    created_by: { type: "uuid", references: "users", onDelete: "SET NULL" },
  });
  pgm.addConstraint("charges", "charge_amount_non_negative", { check: '"amount" >= 0' });
  pgm.addConstraint("charges", "arrear_requires_source_year",
    { check: '(is_arrear = false) OR (source_year_id IS NOT NULL)' });
  pgm.addConstraint("charges", "uniq_charge_reversed_by", { unique: ["reversed_by"] });
  pgm.createIndex("charges", ["enrollment_id", "due_on"]);
  pgm.createIndex("charges", ["school_id", "due_on"]);

  pgm.createTable("concessions", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    school_id: { type: "uuid", notNull: true, references: "schools", onDelete: "CASCADE" },
    enrollment_id: { type: "uuid", notNull: true, references: "enrollments", onDelete: "RESTRICT" },
    fee_head_id: { type: "uuid", references: "fee_heads", onDelete: "RESTRICT" },
    reason: {
      type: "text", notNull: true,
      check: "reason IN ('sibling', 'staff_ward', 'rte', 'merit', 'hardship', 'other')",
    },
    note: { type: "text", notNull: true, default: "" },
    amount: { type: "bigint", notNull: true }, // paise
    approved_by: { type: "uuid", notNull: true, references: "users", onDelete: "RESTRICT" },
    is_government_reimbursed: { type: "boolean", notNull: true, default: false },
    reversed_by: { type: "uuid", references: "concessions", onDelete: "RESTRICT" },
    reversal_reason: { type: "text", notNull: true, default: "" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    created_by: { type: "uuid", references: "users", onDelete: "SET NULL" },
  });
  pgm.addConstraint("concessions", "concession_amount_non_negative", { check: '"amount" >= 0' });
  pgm.addConstraint("concessions", "uniq_concession_reversed_by", { unique: ["reversed_by"] });

  pgm.createTable("payments", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    school_id: { type: "uuid", notNull: true, references: "schools", onDelete: "CASCADE" },
    receipt_no: { type: "text", notNull: true },
    enrollment_id: { type: "uuid", notNull: true, references: "enrollments", onDelete: "RESTRICT" },
    amount: { type: "bigint", notNull: true }, // paise
    mode: {
      type: "text", notNull: true,
      check: "mode IN ('cash', 'upi', 'card', 'netbanking', 'neft', 'cheque', 'dd')",
    },
    clearing_status: {
      type: "text", notNull: true, default: "pending",
      check: "clearing_status IN ('pending', 'cleared', 'bounced', 'failed')",
    },
    received_on: { type: "date", notNull: true, default: pgm.func("current_date") },
    cleared_on: { type: "date" },
    instrument_ref: { type: "text", notNull: true, default: "" },
    collected_by: { type: "uuid", references: "users", onDelete: "SET NULL" },
    // Gateway fields — never store card numbers here (RBI tokenisation).
    gateway: { type: "text", notNull: true, default: "" },
    gateway_order_id: { type: "text", notNull: true, default: "" },
    gateway_payment_id: { type: "text", notNull: true, default: "" },
    convenience_fee: { type: "bigint", notNull: true, default: 0 },
    settled_on: { type: "date" },
    reversed_by: { type: "uuid", references: "payments", onDelete: "RESTRICT" },
    reversal_reason: { type: "text", notNull: true, default: "" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    created_by: { type: "uuid", references: "users", onDelete: "SET NULL" },
  });
  pgm.addConstraint("payments", "uniq_receipt_no_per_school", { unique: ["school_id", "receipt_no"] });
  pgm.addConstraint("payments", "payment_amount_positive", { check: '"amount" > 0' });
  pgm.addConstraint("payments", "uniq_payment_reversed_by", { unique: ["reversed_by"] });
  // Webhook idempotency: gateways retry, duplicate, and reorder deliveries.
  // Without this a retried webhook would double-credit a parent.
  pgm.createIndex("payments", ["gateway", "gateway_payment_id"], {
    unique: true,
    where: `"gateway_payment_id" != ''`,
  });
  pgm.createIndex("payments", ["school_id", "received_on"]);

  pgm.createTable("allocations", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    school_id: { type: "uuid", notNull: true, references: "schools", onDelete: "CASCADE" },
    payment_id: { type: "uuid", notNull: true, references: "payments", onDelete: "RESTRICT" },
    charge_id: { type: "uuid", notNull: true, references: "charges", onDelete: "RESTRICT" },
    amount: { type: "bigint", notNull: true }, // paise
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint("allocations", "uniq_allocation_per_payment_charge",
    { unique: ["payment_id", "charge_id"] });
  pgm.addConstraint("allocations", "allocation_amount_positive", { check: '"amount" > 0' });
};

exports.down = (pgm) => {
  pgm.dropTable("allocations");
  pgm.dropTable("payments");
  pgm.dropTable("concessions");
  pgm.dropTable("charges");
  pgm.dropTable("invoices");
};
