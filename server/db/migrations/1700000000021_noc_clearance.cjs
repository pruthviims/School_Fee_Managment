/**
 * Adds what the NOC/clearance workflow needs on top of the existing TC
 * request lifecycle, rather than a parallel table: NOC and TC share the
 * exact same request/clear/issue shape (a school reviews an exit, then
 * either stops at "cleared" — the new NOC-approved state this app is
 * responsible for — or goes on to "issued", the official TC a human
 * still does through the government portal). exit_reason is a
 * controlled category (TC / Admission Cancelled / Dropout /
 * Transferred / Other) distinct from the existing free-text `reason`
 * column, which stays exactly what it always was: the student's own
 * stated reason for requesting a TC, not the exit-reason classification
 * management assigns at clearance time. financial_snapshot captures
 * charged/gross paid/refunded/net paid/outstanding at the moment NOC
 * is approved, for audit — those numbers can otherwise drift if a
 * refund or concession is recorded against the enrollment afterward.
 * noc_number gets its own document_counters series (a new doc_type,
 * 'noc') rather than reusing 'tc' — an NOC is explicitly not a TC, and
 * must never look like one. refunds.receipt_no gets the same
 * treatment via a new 'refund' doc_type, giving a refund its own
 * document identity distinct from both the original fee receipt and
 * an NOC.
 */
exports.up = (pgm) => {
  pgm.addColumns("tc_requests", {
    exit_reason: {
      type: "text",
      check: "exit_reason IN ('tc', 'admission_cancelled', 'dropout', 'transferred', 'other')",
    },
    financial_snapshot: { type: "jsonb" },
    noc_number: { type: "text" },
  });

  // A refund's own document identity — nothing before this reused any
  // existing counter for it, so a refund receipt had no way to be
  // distinguished from a fee receipt or an NOC. received_by: the
  // refund's own approver_name/refunded_by already capture who
  // approved and who processed it, but not who actually collected the
  // money on the family's side — free text, not a user reference,
  // since whoever receives a refund is very often not a portal user
  // at all (a parent, a guardian). Both nullable: every refund already
  // in the table predates this and simply has neither, which is the
  // correct historical state rather than something to backfill.
  pgm.addColumns("refunds", {
    receipt_no: { type: "text" },
    received_by: { type: "text", notNull: true, default: "" },
  });

  pgm.dropConstraint("document_counters", "document_counters_doc_type_check");
  pgm.addConstraint("document_counters", "document_counters_doc_type_check",
    { check: "doc_type IN ('receipt', 'invoice', 'tc', 'refund', 'noc')" });
};

exports.down = (pgm) => {
  pgm.dropConstraint("document_counters", "document_counters_doc_type_check");
  pgm.addConstraint("document_counters", "document_counters_doc_type_check",
    { check: "doc_type IN ('receipt', 'invoice', 'tc')" });

  pgm.dropColumns("refunds", ["receipt_no", "received_by"]);
  pgm.dropColumns("tc_requests", ["exit_reason", "financial_snapshot", "noc_number"]);
};
