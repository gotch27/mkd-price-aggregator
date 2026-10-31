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
it("adds brand review and source freshness metadata without authorizing work or changing category decisions", async () => {
  const c = await pool.connect(),
    schema = "brand_migration_" + randomUUID().replaceAll("-", "");
  try {
    await c.query("BEGIN");
    await c.query(`CREATE SCHEMA ${schema}`);
    await c.query(`SET LOCAL search_path TO ${schema},public`);
    await c.query(`CREATE TABLE brands(id uuid PRIMARY KEY,slug text);CREATE TABLE brand_edits(id uuid);
      CREATE TABLE store_products(id uuid PRIMARY KEY,retailer text,name text,description text,category text,gtin text,manual_facts jsonb,classification_key text);
      CREATE TABLE store_product_classifications(id uuid,store_product_id uuid,input_key text,model text,prompt_key text,created_at timestamptz);
      CREATE TABLE task_executions(id uuid PRIMARY KEY);`);
    const p = randomUUID();
    await c.query(
      "INSERT INTO store_products VALUES($1,'kam','Original name',NULL,NULL,NULL,'{}','preserved-key')",
      [p],
    );
    await c.query(
      "INSERT INTO store_product_classifications VALUES($1,$2,'preserved-key','current-model','current-prompt',now())",
      [randomUUID(), p],
    );
    await c.query(await readFile("migrations/044_brand_review.sql", "utf8"));
    expect(
      (await c.query("SELECT classification_key FROM store_products")).rows[0]
        .classification_key,
    ).toBe("preserved-key");
    expect(
      (await c.query("SELECT * FROM classification_source_snapshots")).rows[0],
    ).toMatchObject({
      input_key: "preserved-key",
      source: { retailer: "kam", name: "Original name", manual_facts: {} },
      model: "current-model",
    });
    for (const table of [
      "task_executions",
      "brand_review_sessions",
      "brand_fact_refresh",
      "matching_primary_preparations",
    ])
      expect(
        (await c.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,
      ).toBe(0);
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
});
