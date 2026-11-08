import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-cache-aware-"));
process.env.DATA_DIR = dir;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
delete process.env.REDIS_URL;
delete process.env.OMNIROUTE_SESSION_AFFINITY_STORE;
const core = await import("../../src/lib/db/core.ts");
const pin = await import("../../src/sse/services/sessionAffinityPin.ts");
const { updateSettingsSchema } = await import("../../src/shared/validation/settingsSchemas.ts");
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dir, { recursive: true, force: true });
});
const settings = {
  sessionAffinityTtlMs: 0,
  providerStrategies: { openai: { fallbackStrategy: "cache-aware" } },
};
test("cache-aware is valid as a provider account override", () => {
  assert.equal(updateSettingsSchema.safeParse(settings).success, true);
});
test("cache-aware opts only its provider into affinity without changing global settings", () => {
  assert.equal(pin.resolveSessionAffinityTtlMs("openai", {}, settings), 1800000);
  assert.equal(pin.resolveSessionAffinityTtlMs("claude", {}, settings), 0);
  assert.equal(
    pin.resolveSessionAffinityTtlMs("openai", { sessionAffinityTtlMs: 120000 }, settings),
    120000
  );
  assert.equal(
    pin.resolveSessionAffinityTtlMs("openai", {}, { ...settings, sessionAffinityTtlMs: 600000 }),
    600000
  );
  assert.equal(settings.sessionAffinityTtlMs, 0);
});
test("provider override wins over global cache-aware strategy", () => {
  assert.equal(
    pin.resolveSessionAffinityTtlMs("openai", {}, { fallbackStrategy: "cache-aware" }),
    1800000
  );
  assert.equal(
    pin.resolveSessionAffinityTtlMs(
      "openai",
      {},
      {
        fallbackStrategy: "cache-aware",
        providerStrategies: { openai: { fallbackStrategy: "priority" } },
      }
    ),
    0
  );
});
test("cache/session identity stays on its account and fails over only to an eligible peer", async () => {
  const key = pin.extractSessionAffinityKey({ prompt_cache_key: "project-stable" });
  const ttl = pin.resolveSessionAffinityTtlMs("openai", {}, settings);
  const a = { id: "cache-a", provider: "openai", priority: 1, lastUsedAt: null };
  const b = { id: "cache-b", provider: "openai", priority: 2, lastUsedAt: null };
  const first = await pin.selectSessionAffinityConnection("openai", key, [a, b], ttl);
  assert.ok(first);
  const other = first.id === a.id ? b : a;
  assert.equal(
    (await pin.selectSessionAffinityConnection("openai", key, [other, first], ttl))?.id,
    first.id
  );
  assert.equal(
    (await pin.selectSessionAffinityConnection("openai", key, [other], ttl))?.id,
    other.id
  );
  assert.equal(await pin.selectSessionAffinityConnection("openai", key, [], ttl), null);
  assert.equal(await pin.selectSessionAffinityConnection("openai", null, [a, b], ttl), null);
});

test("credential selection honors cache-aware with global affinity disabled and can fail over", async () => {
  const providers = await import("../../src/lib/db/providers.ts");
  const settingsDb = await import("../../src/lib/db/settings.ts");
  const auth = await import("../../src/sse/services/auth.ts");
  await settingsDb.updateSettings(settings);
  for (const name of ["cache-integration-a", "cache-integration-b"]) {
    await providers.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      apiKey: name,
      name,
      isActive: true,
      testStatus: "active",
    });
  }
  const options = { sessionKey: "cache-aware-integration" };
  const first = await auth.getProviderCredentials("openai", null, null, "gpt-4o", options);
  assert.ok(first?.connectionId);
  const second = await auth.getProviderCredentials("openai", null, null, "gpt-4o", options);
  assert.equal(second?.connectionId, first.connectionId);
  const fallback = await auth.getProviderCredentials(
    "openai",
    first.connectionId,
    null,
    "gpt-4o",
    options
  );
  assert.ok(fallback?.connectionId);
  assert.notEqual(fallback.connectionId, first.connectionId);
  assert.equal((await settingsDb.getSettings()).sessionAffinityTtlMs, 0);
});
