import pool from "./pool.ts";

async function seed() {
  const email = process.env.MANAGER_EMAIL ?? "manager@resolveai.local";
  const password = process.env.MANAGER_PASSWORD;
  if (!password || password.length < 8)
    throw new Error("MANAGER_PASSWORD with at least 8 characters is required");
  const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
  await pool.query(
    `INSERT INTO users(name,email,password_hash,role) VALUES($1,$2,$3,'manager')
    ON CONFLICT(email) DO UPDATE SET name=excluded.name,password_hash=excluded.password_hash,role='manager',active=true,updated_at=now()`,
    [process.env.MANAGER_NAME ?? "Resolve Aí Manager", email, hash],
  );
  console.log(`Manager seeded: ${email}`);
}
if (import.meta.main)
  seed()
    .then(() => pool.end())
    .catch(async (e) => {
      console.error(e);
      await pool.end();
      process.exitCode = 1;
    });
