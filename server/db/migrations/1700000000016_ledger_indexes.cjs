/**
 * Postgres never auto-indexes a foreign key column the way some other
 * databases do — these three were missing since the very first ledger
 * migration. Not a problem at the small scale every prior test used,
 * but surfaced as a real, reproducible failure once GET /enrollments
 * started aggregating ledger totals per row (see the same-named
 * change in students.ts): a school with 1,500+ students made this
 * genuinely too slow to load without them.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createIndex("concessions", ["enrollment_id"]);
  pgm.createIndex("allocations", ["charge_id"]);
  pgm.createIndex("allocations", ["payment_id"]);
};

exports.down = (pgm) => {
  pgm.dropIndex("allocations", ["payment_id"]);
  pgm.dropIndex("allocations", ["charge_id"]);
  pgm.dropIndex("concessions", ["enrollment_id"]);
};
