import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { PoolClient } from "pg";
import pool from "../../db/pool.ts";
import { migrate } from "../../db/migrate.ts";
import { ensureTestDatabase } from "./test-database.ts";

let client: PoolClient | undefined;

beforeAll(async () => {
  await ensureTestDatabase();
  await migrate();
  client = await pool.connect();
});

beforeEach(async () => {
  await client!.query("BEGIN");
});

afterEach(async () => {
  await client?.query("ROLLBACK");
});

afterAll(async () => {
  client?.release();
  await pool.end();
});

async function user(role: "requester" | "manager") {
  const result = await client!.query<{ id: string }>(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, $2, 'hash', $3) RETURNING id`,
    [`Test ${role}`, `${role}-${crypto.randomUUID()}@example.com`, role],
  );
  return result.rows[0]!.id;
}

async function incident(requesterId: string, assigneeId?: string) {
  const category = await client!.query<{ id: string }>(
    "SELECT id FROM categories ORDER BY slug LIMIT 1",
  );
  const result = await client!.query<{ id: string }>(
    `INSERT INTO incidents
       (requester_id, category_id, assignee_id, title, description, address)
     VALUES ($1, $2, $3, 'Broken light', 'The hallway light is broken', 'Block A')
     RETURNING id`,
    [requesterId, category.rows[0]!.id, assigneeId ?? null],
  );
  return result.rows[0]!.id;
}

describe("initial database schema", () => {
  it("seeds all initial categories", async () => {
    const result = await client!.query<{ count: string }>("SELECT count(*) FROM categories");
    expect(Number(result.rows[0]!.count)).toBe(8);
  });

  it("creates the initial status history atomically", async () => {
    const requesterId = await user("requester");
    const incidentId = await incident(requesterId);
    const result = await client!.query(
      `SELECT previous_status, new_status, changed_by
       FROM status_history WHERE incident_id = $1`,
      [incidentId],
    );

    expect(result.rows).toEqual([{
      previous_status: null,
      new_status: "open",
      changed_by: requesterId,
    }]);
  });

  it("only permits active managers as assignees", async () => {
    const requesterId = await user("requester");
    await expect(incident(requesterId, requesterId)).rejects.toThrow(
      "assignee_id must reference an active manager",
    );
  });

  it("keeps status history append-only", async () => {
    const requesterId = await user("requester");
    const incidentId = await incident(requesterId);
    await expect(
      client!.query("DELETE FROM status_history WHERE incident_id = $1", [incidentId]),
    ).rejects.toThrow("status_history is append-only");
  });

  it("only accepts a rating from the owner of a resolved incident", async () => {
    const requesterId = await user("requester");
    const managerId = await user("manager");
    const incidentId = await incident(requesterId, managerId);

    await client!.query(
      `UPDATE incidents SET status = 'resolved', solution = 'Lamp replaced',
         resolved_by = $2, resolved_at = now() WHERE id = $1`,
      [incidentId, managerId],
    );
    await client!.query(
      "INSERT INTO ratings (incident_id, author_id, score) VALUES ($1, $2, 5)",
      [incidentId, requesterId],
    );
    const result = await client!.query<{ score: number }>(
      "SELECT score FROM ratings WHERE incident_id = $1",
      [incidentId],
    );
    expect(result.rows[0]!.score).toBe(5);
  });
});
