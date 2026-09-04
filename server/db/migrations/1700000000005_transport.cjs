/**
 * Transport is priced by route/stop, never by class — deliberately
 * outside fee_structures. See fee_heads.basis = 'per_slab'.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable("bus_routes", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    school_id: { type: "uuid", notNull: true, references: "schools", onDelete: "CASCADE" },
    code: { type: "text", notNull: true }, // "R-04"
    name: { type: "text", notNull: true },
    distance_km: { type: "numeric(5,1)" },
    vehicle_no: { type: "text", notNull: true, default: "" },
    driver_name: { type: "text", notNull: true, default: "" },
    driver_phone: { type: "text", notNull: true, default: "" },
    seats: { type: "smallint", notNull: true, default: 40 },
    is_active: { type: "boolean", notNull: true, default: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint("bus_routes", "uniq_route_code_per_school", { unique: ["school_id", "code"] });

  pgm.createTable("route_stops", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    school_id: { type: "uuid", notNull: true, references: "schools", onDelete: "CASCADE" },
    route_id: { type: "uuid", notNull: true, references: "bus_routes", onDelete: "CASCADE" },
    name: { type: "text", notNull: true },
    sequence: { type: "smallint", notNull: true, default: 1 },
    pickup_time: { type: "time" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint("route_stops", "uniq_stop_name_per_route", { unique: ["route_id", "name"] });

  pgm.createTable("transport_fares", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    school_id: { type: "uuid", notNull: true, references: "schools", onDelete: "CASCADE" },
    academic_year_id: { type: "uuid", notNull: true, references: "academic_years", onDelete: "RESTRICT" },
    stop_id: { type: "uuid", notNull: true, references: "route_stops", onDelete: "RESTRICT" },
    amount: { type: "bigint", notNull: true }, // paise
    term_no: { type: "smallint", notNull: true, default: 1 },
    due_on: { type: "date", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint("transport_fares", "uniq_transport_fare_line",
    { unique: ["school_id", "academic_year_id", "stop_id", "term_no"] });
};

exports.down = (pgm) => {
  pgm.dropTable("transport_fares");
  pgm.dropTable("route_stops");
  pgm.dropTable("bus_routes");
};
