import { Pool, types, type QueryResultRow } from "pg";

// Postgres bigint (OID 20) comes back as a string by default, to avoid
// silent precision loss for values outside JS's safe integer range. Every
// bigint column in this schema is money in paise, which never gets
// anywhere near that limit (₹90 lakh crore before it would matter) — so
// parsing as a number here, once, is safe and saves converting at every
// call site that touches an amount.
types.setTypeParser(20, (value: string) => Number(value));

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
