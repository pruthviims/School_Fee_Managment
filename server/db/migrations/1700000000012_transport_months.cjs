/**
 * How many months of the academic year a student actually rides —
 * entered directly by the office (a mid-year joiner might ride 7 of
 * the 10 months a year runs), rather than derived from started_on/
 * ended_on. The date range stays for record-keeping (when did this
 * assignment start, when did it end), but months is what actually
 * drives the prorated fee: annual stop fare / 10 * months. Ten, not
 * twelve — the academic year itself runs about ten months once
 * holidays are excluded, which is the whole reason this column exists
 * rather than just prorating by calendar days.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn("transport_assignments", {
    months: { type: "smallint", notNull: true, default: 10 },
  });
  pgm.addConstraint("transport_assignments", "chk_transport_months_range",
    "CHECK (months >= 1 AND months <= 10)");
};

exports.down = (pgm) => {
  pgm.dropConstraint("transport_assignments", "chk_transport_months_range");
  pgm.dropColumn("transport_assignments", "months");
};
