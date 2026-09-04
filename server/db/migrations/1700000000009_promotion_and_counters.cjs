/**
 * PromotionBatch: preview -> adjust -> commit. Every Enrollment created by
 * a promotion carries the batch id, which is what makes the whole
 * rollover auditable and reversible while the target year is still in
 * 'planning' — see server/services/promotion.ts.
 *
 * document_counters: receipt/invoice numbers must be sequential AND
 * gapless per financial year for audit purposes. Issued under
 * SELECT ... FOR UPDATE inside the same transaction that writes the
 * Payment/Invoice row — see server/services/documentCounter.ts. An
 * auto-increment id would leave gaps on rollback; a uuid has no order.
 * Neither is acceptable for a financial document number.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable("promotion_batches", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    school_id: { type: "uuid", notNull: true, references: "schools", onDelete: "CASCADE" },
    from_year_id: { type: "uuid", notNull: true, references: "academic_years", onDelete: "RESTRICT" },
    to_year_id: { type: "uuid", notNull: true, references: "academic_years", onDelete: "RESTRICT" },
    status: {
      type: "text", notNull: true, default: "draft",
      check: "status IN ('draft', 'committed', 'reversed')",
    },
    committed_at: { type: "timestamptz" },
    committed_by: { type: "uuid", references: "users", onDelete: "SET NULL" },
    carry_forward_arrears: { type: "boolean", notNull: true, default: true },
    block_on_dues: { type: "boolean", notNull: true, default: false },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    created_by: { type: "uuid", references: "users", onDelete: "SET NULL" },
  });

  pgm.addConstraint("enrollments", "fk_enrollments_promotion_batch",
    { foreignKeys: { columns: "promotion_batch_id", references: "promotion_batches", onDelete: "SET NULL" } });

  pgm.createTable("document_counters", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    school_id: { type: "uuid", notNull: true, references: "schools", onDelete: "CASCADE" },
    doc_type: { type: "text", notNull: true, check: "doc_type IN ('receipt', 'invoice')" },
    fiscal_year: { type: "text", notNull: true }, // "2026-27"
    prefix: { type: "text", notNull: true, default: "" },
    next_value: { type: "integer", notNull: true, default: 1 },
  });
  pgm.addConstraint("document_counters", "uniq_doc_counter",
    { unique: ["school_id", "doc_type", "fiscal_year"] });
};

exports.down = (pgm) => {
  pgm.dropTable("document_counters");
  pgm.dropConstraint("enrollments", "fk_enrollments_promotion_batch");
  pgm.dropTable("promotion_batches");
};
