import { Pool, type QueryResultRow } from "pg";

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
