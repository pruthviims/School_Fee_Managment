/**
 * Three additions confirmed with the client: blood group (optional),
 * and — replacing the single combined guardian contact — a genuine
 * choice between recording both Parents (father and mother, both
 * required) or a single Guardian with their relationship to the
 * student (for the real cases where neither parent is the actual
 * contact).
 *
 * contact_type defaults to 'guardian' for every existing row, since
 * that's exactly what the old single guardian_name/phone/email always
 * represented — no backfill needed, no data reinterpreted.
 *
 * guardian_name/guardian_phone/guardian_email are kept exactly as they
 * were, not renamed or dropped: every existing consumer (Fee
 * Collection's table, receipts, the TC certificate, reminders) reads
 * them as "the primary contact" and continues to unmodified. When
 * contact_type is 'parents', the API layer populates these three from
 * whichever parent is actually reachable, so nothing downstream needs
 * to learn a new shape just to keep working.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns("students", {
    blood_group: { type: "text", notNull: true, default: "" },
    contact_type: {
      type: "text", notNull: true, default: "guardian",
      check: "contact_type IN ('parents', 'guardian')",
    },
    father_name: { type: "text", notNull: true, default: "" },
    father_phone: { type: "text", notNull: true, default: "" },
    father_email: { type: "text", notNull: true, default: "" },
    mother_name: { type: "text", notNull: true, default: "" },
    mother_phone: { type: "text", notNull: true, default: "" },
    mother_email: { type: "text", notNull: true, default: "" },
    guardian_relationship: { type: "text", notNull: true, default: "" },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns("students", [
    "blood_group", "contact_type", "father_name", "father_phone", "father_email",
    "mother_name", "mother_phone", "mother_email", "guardian_relationship",
  ]);
};
