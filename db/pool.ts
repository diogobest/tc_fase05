import { Pool } from "pg";

export function createPool(env = process.env) {
  let database = env.POSTGRES_DB || "tc_db_dev";

  if (env.NODE_ENV === "test") database = env.POSTGRES_TEST_DB || "tc_db_test";
  if (env.NODE_ENV === "production")
    database = env.POSTGRES_PROD_DB || "tc_db_prod";

  return new Pool({
    user: env.POSTGRES_USER || "postgres",
    password: env.POSTGRES_PASSWORD || "postgres",
    database,
    host: env.POSTGRES_HOST || "db",
    port: Number(env.POSTGRES_PORT || 5432),
  });
}

export default createPool();
