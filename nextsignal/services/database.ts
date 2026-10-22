import pg, { type PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { settings } from "@/nextsignal/config";
export const pool = new pg.Pool({
  connectionString: settings.database.url,
  max: settings.database.pool_size,
  options: `-c pg_trgm.similarity_threshold=${settings.matching.candidate_similarity}`,
  connectionTimeoutMillis: settings.database.connection_timeout_ms,
  idleTimeoutMillis: settings.database.idle_timeout_ms,
});
export const db = drizzle(pool);
export async function transaction<T>(
  handle: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const result = await handle(c);
    await c.query("COMMIT");
    return result;
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  } finally {
    c.release();
  }
}
export async function withLock<T>(
  key: string,
  handle: () => Promise<T>,
): Promise<T | null> {
  const c = await pool.connect();
  let locked = false;
  try {
    const { rows } = await c.query(
      "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
      [key],
    );
    locked = rows[0].locked;
    if (!locked) return null;
    return await handle();
  } finally {
    try {
      if (locked)
        await c.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
          key,
        ]);
    } catch (error) {
      c.release(true);
      throw error;
    }
    c.release();
  }
}
