import app from "./app.ts";
import pool from "../db/pool.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const server = app.listen(config.port, () => console.log(JSON.stringify({ event: "server_started", port: config.port })));
async function shutdown(signal: string) {
  console.log(JSON.stringify({ event: "shutdown", signal }));
  server.close(async () => { await pool.end(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
