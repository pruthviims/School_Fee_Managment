import { Pool, types, type QueryResultRow } from "pg";

// Postgres bigint (OID 20) comes back as a string by default, to avoid
// silent precision loss for values outside JS's safe integer range. Every
// bigint column in this schema is money in paise, which never gets
// anywhere near that limit (₹90 lakh crore before it would matter) — so
// parsing as a number here, once, is safe and saves converting at every
// call site that touches an amount.
//
// numeric (OID 1700) needs the same treatment for a less obvious reason:
// SUM() over a bigint column returns numeric, not bigint — Postgres's own
// overflow-avoidance rule — so every aggregate query on a money column
// would otherwise come back as a string even though the column itself
// parses correctly. This was silently masked wherever a summed value
// only ever went through arithmetic (JS coerces "100" - "50" to numbers
// automatically), and only surfaced as a real bug once a test compared
// a summed value with toBe() instead of using it in arithmetic.
types.setTypeParser(20, (value: string) => Number(value));
types.setTypeParser(1700, (value: string) => Number(value));

// Neon (and most managed Postgres) handle bursty serverless connect/
// disconnect patterns via their own pooler in front of the database, so a
// small pool size here is intentional — it isn't fighting the platform,
// it's cooperating with it. Point DATABASE_URL at Neon's *pooled*
// connection string in production (the one with "-pooler" in the host).
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.warn(
    "[db] DATABASE_URL is not set — queries will fail until it's configured " +
    "(see .env.example)."
  );
}

export const pool = new Pool({
  connectionString,
  ssl: connectionString?.includes("sslmode=disable")
    ? false
    : { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX) || 5,
});

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string, params: unknown[] = [],
) {
  return pool.query<T>(text, params);
}
