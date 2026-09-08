/**
 * A school's logo, stored directly as a data URL rather than in object
 * storage — the deliberate, discussed choice for a self-hosted, single-
 * (or few-)school deployment: one small, rarely-changed image per
 * school, so there's nothing gained by a separate storage service and
 * a real, if small, cost in operational complexity (another account,
 * another token, another thing that can be misconfigured). logo_key
 * stays as-is, unused — it was reserved for exactly the object-storage
 * approach this deliberately isn't taking; repurposing its meaning
 * would be more confusing than leaving it and adding a clearly-named
 * column instead.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn("schools", {
    logo_data_url: { type: "text", notNull: true, default: "" },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn("schools", "logo_data_url");
};
