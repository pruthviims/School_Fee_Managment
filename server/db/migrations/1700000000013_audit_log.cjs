/**
 * A single, append-only trail of who did what, across every write
 * action in the system — the school asked specifically to be able to
 * answer "who modified this student," "who did this admission," "who
 * promoted this student" after the fact, for anything, not just a
 * curated subset.
 *
 * user_name and user_role are frozen at the moment of the action, not
 * looked up live from the user/membership tables — the same reasoning
 * as head_name on charges: a name change or a role change later
 * shouldn't rewrite history. "Logs at the role level" (as asked) means
 * this: the role someone held *at the time* they did something is part
 * of the permanent record, even if they're promoted to owner next
 * month or leave the school entirely.
 *
 * entity_type/entity_id point at whatever the action touched (a
 * student, an enrollment, a payment...) without a foreign key —
 * deliberately: an audit entry must survive the record it describes
 * being altered or even reversed later, and a real FK would force an
 * awkward choice between ON DELETE SET NULL (losing the reference
 * silently) or RESTRICT (which would make some legitimate future
 * hard-delete impossible). The entity may not even share one table
 * across every action type.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable("audit_log", {
    id: { type: "uuid", default: pgm.func("gen_random_uuid()"), primaryKey: true },
    school_id: { type: "uuid", notNull: true, references: "schools", onDelete: "CASCADE" },
    user_id: { type: "uuid", references: "users", onDelete: "SET NULL" },
    user_name: { type: "text", notNull: true },
    user_role: { type: "text", notNull: true },
    action: { type: "text", notNull: true },
    entity_type: { type: "text", notNull: true },
    entity_id: { type: "uuid" },
    description: { type: "text", notNull: true },
    metadata: { type: "jsonb" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.createIndex("audit_log", ["school_id", "created_at"]);
  pgm.createIndex("audit_log", ["school_id", "entity_type", "entity_id"]);
};

exports.down = (pgm) => {
  pgm.dropTable("audit_log");
};
