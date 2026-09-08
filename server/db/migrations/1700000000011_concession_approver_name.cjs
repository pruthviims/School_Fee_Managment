/**
 * Who in management actually approved a concession — a name typed in
 * free text, deliberately separate from approved_by (the staff account
 * that operated the software to record it, already joined and aliased
 * as approved_by_name in GET .../concessions — a different, established
 * meaning this column must not collide with). Those are genuinely
 * different pieces of information: the Principal approves a fee waiver
 * over a phone call or in person; the front-desk clerk is the one
 * signed in and typing it into the system. Free text rather than a
 * link to a real account, since the approving manager may not have
 * (or need) their own login here at all.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn("concessions", {
    approver_name: { type: "text", notNull: true, default: "" },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn("concessions", "approver_name");
};
