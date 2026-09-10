/**
 * Real bug, found while investigating a client-reported error on
 * "copy fees to other classes": Postgres treats every NULL as
 * distinct from every other NULL in a unique constraint by default,
 * so uniq_fee_structure_line's stream_id column never actually
 * caught a duplicate for any class without a stream — which is
 * nearly every class, since only 1st/2nd PU typically have one.
 * Two fee_structure rows for the identical (school, year, class,
 * fee_head, term) could both exist silently whenever stream_id was
 * NULL for both, which is exactly the shape "copy fees" (or a
 * retried admission-adjacent action) could produce — and duplicate
 * fee_structure lines mean generateCharges (billing.ts) would charge
 * a student twice for the same fee head and term.
 *
 * NULLS NOT DISTINCT (Postgres 15+) makes NULL compare equal to NULL
 * specifically for this constraint, so two rows with stream_id NULL
 * now correctly conflict — closing the gap ON CONFLICT-based
 * deduplication (used by fee-structure/copy, added alongside this)
 * relies on.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE fee_structures DROP CONSTRAINT uniq_fee_structure_line;
    ALTER TABLE fee_structures ADD CONSTRAINT uniq_fee_structure_line
      UNIQUE NULLS NOT DISTINCT (school_id, academic_year_id, class_level_id, fee_head_id, stream_id, term_no);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE fee_structures DROP CONSTRAINT uniq_fee_structure_line;
    ALTER TABLE fee_structures ADD CONSTRAINT uniq_fee_structure_line
      UNIQUE (school_id, academic_year_id, class_level_id, fee_head_id, stream_id, term_no);
  `);
};
