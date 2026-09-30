import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fork-release-migration-"));
process.env.OMNIROUTE_MIGRATIONS_DIR = dir;
fs.writeFileSync(
  path.join(dir, "177_provider_connection_synced_models_at.sql"),
  "ALTER TABLE provider_connections ADD COLUMN synced_models_at TEXT;"
);
fs.writeFileSync(
  path.join(dir, "197_api_key_codex_service_mode.sql"),
  "ALTER TABLE api_keys ADD COLUMN codex_service_mode TEXT NOT NULL DEFAULT 'inherit';"
);
const { runMigrations } = await import("../../src/lib/db/migrationRunner.ts");
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

for (const legacy of [true, false]) {
  test(`service mode survives release upgrade (legacy fork: ${legacy})`, () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE provider_connections (id TEXT PRIMARY KEY);
        CREATE TABLE api_keys (id TEXT PRIMARY KEY${legacy ? ", codex_service_mode TEXT DEFAULT 'inherit'" : ""});
        CREATE TABLE _omniroute_migrations (
          version TEXT PRIMARY KEY, name TEXT NOT NULL,
          applied_at TEXT NOT NULL DEFAULT (datetime('now')));
      `);
      if (legacy) {
        db.exec("INSERT INTO api_keys VALUES ('key', 'priority');");
        db.exec(
          "INSERT INTO _omniroute_migrations(version,name) VALUES ('177','api_key_codex_service_mode');"
        );
      } else db.exec("INSERT INTO api_keys(id) VALUES ('key');");
      runMigrations(db);
      assert.deepEqual(db.prepare("SELECT codex_service_mode FROM api_keys").get(), {
        codex_service_mode: legacy ? "priority" : "inherit",
      });
      assert.ok(
        (
          db.prepare("PRAGMA table_info(provider_connections)").all() as Array<{ name: string }>
        ).some((column) => column.name === "synced_models_at")
      );
      assert.deepEqual(
        db.prepare("SELECT version,name FROM _omniroute_migrations ORDER BY version").all(),
        [
          { version: "177", name: "provider_connection_synced_models_at" },
          { version: "197", name: "api_key_codex_service_mode" },
        ]
      );
      assert.equal(runMigrations(db), 0);
    } finally {
      db.close();
    }
  });
}
