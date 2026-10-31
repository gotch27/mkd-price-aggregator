import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it, afterAll } from "vitest";
import { pool } from "@/nextsignal/services/database";
it("adds preparation state without changing saved permissions, budgets, product IDs or decision history", async () => {
  const c = await pool.connect(),
    schema = "identity_migration_" + randomUUID().replaceAll("-", "");
  try {
    await c.query("BEGIN");
    await c.query(`CREATE SCHEMA ${schema}`);
    await c.query(`SET LOCAL search_path TO ${schema},public`);
    await c.query(`CREATE TABLE store_products(id uuid PRIMARY KEY);CREATE TABLE task_executions(id uuid PRIMARY KEY);
    CREATE TABLE store_match_decisions(id uuid PRIMARY KEY,store_product_id uuid,campaign_id uuid,created_at timestamptz,reason text);
    CREATE TABLE operational_settings(id boolean PRIMARY KEY,revision int,policy jsonb,updated_by text,updated_at timestamptz);
    CREATE TABLE operational_settings_history(revision int,actor text,before_policy jsonb,after_policy jsonb,changes jsonb);`);
    const id = randomUUID(),
      policy = {
        ai_enabled: false,
        matching: "manual",
        categorization: "automatic",
        initial_budget_usd: 23.5,
        monthly_budget_usd: 1.75,
      };
    await c.query("INSERT INTO store_products VALUES($1)", [id]);
    await c.query(
      "INSERT INTO store_match_decisions VALUES($1,$2,$3,now(),'Historical unresolved reason')",
      [randomUUID(), id, randomUUID()],
    );
    await c.query(
      "INSERT INTO operational_settings VALUES(true,17,$1,'person',now())",
      [policy],
    );
    await c.query(
      await readFile("migrations/043_matching_identity.sql", "utf8"),
    );
    const saved = (await c.query("SELECT * FROM operational_settings")).rows[0];
    expect(saved.revision).toBe(18);
    expect(saved.policy).toEqual({
      ...policy,
      counterpart_limit: 50,
      counterparts_per_product: 5,
    });
    expect((await c.query("SELECT * FROM store_products")).rows).toEqual([
      { id },
    ]);
    expect(
      (await c.query("SELECT reason FROM store_match_decisions")).rows[0]
        .reason,
    ).toBe("Historical unresolved reason");
    expect(
      (
        await c.query(
          "SELECT count(*)::int count FROM matching_product_preparations",
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (await c.query("SELECT before_policy FROM operational_settings_history"))
        .rows[0].before_policy,
    ).toEqual(policy);
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
});
afterAll(() => pool.end());
