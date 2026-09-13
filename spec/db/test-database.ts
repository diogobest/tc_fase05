import { Client } from "pg";

export async function ensureTestDatabase(env = process.env): Promise<void> {
  const database = env.POSTGRES_TEST_DB || "tc_db_test";
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(database)) {
    throw new Error("POSTGRES_TEST_DB must be a valid PostgreSQL identifier");
  }

  const client = new Client({
    user: env.POSTGRES_USER || "postgres",
    password: env.POSTGRES_PASSWORD || "postgres",
    database: env.POSTGRES_ADMIN_DB || "postgres",
    host: env.POSTGRES_HOST || "db",
    port: Number(env.POSTGRES_PORT || 5432),
  });

  await client.connect();
  try {
    const result = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [database],
    );
    if (!result.rowCount) {
      await client.query(`CREATE DATABASE "${database}"`);
    }
  } finally {
    await client.end();
  }
}
