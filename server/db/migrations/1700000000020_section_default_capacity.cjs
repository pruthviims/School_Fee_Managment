/**
 * Raises sections.capacity's own default from 40 to 100 — a new
 * section created without an explicit capacity (the common case: New
 * Admission's "+ Add new section", the bulk importer, Fees Setup) now
 * starts at 100 instead of 40. Deliberately only the default: every
 * section already created keeps whatever capacity it already has,
 * since this is a change to what happens going forward, not a
 * retroactive rewrite of existing sections' own configured capacity.
 */
exports.up = (pgm) => {
  pgm.alterColumn("sections", "capacity", { default: 100 });
};

exports.down = (pgm) => {
  pgm.alterColumn("sections", "capacity", { default: 40 });
};
