import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-codex-account-catalog-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const auth = await import("../../src/sse/services/auth.ts");

const PROVIDER = "codex";

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function createConnection(data: Record<string, unknown>): Promise<string> {
  const created = (await providersDb.createProviderConnection(data)) as { id: string };
  return created.id;
}

/** The connection id the selector handed back, or null if it returned no account. */
function selectedConnectionId(selected: unknown): string | null {
  if (!selected || typeof selected !== "object") return null;
  const id = (selected as { connectionId?: unknown }).connectionId;
  return typeof id === "string" ? id : null;
}

/** Create accounts with shared and subscription-specific model inventories. */
async function seedTwoAccounts(options: { proRateLimitedUntil?: string } = {}) {
  const proId = await createConnection({
    provider: PROVIDER,
    authType: "oauth",
    accessToken: "test-codex-token",
    name: "Pro account",
    priority: 1,
    isActive: true,
  });
  const plusId = await createConnection({
    provider: PROVIDER,
    authType: "oauth",
    accessToken: "test-codex-token",
    name: "Plus account",
    priority: 2,
    isActive: true,
  });

  await modelsDb.replaceSyncedAvailableModelsForConnection(PROVIDER, proId, [
    { id: "gpt-shared-test", name: "gpt-shared-test" },
    { id: "gpt-pro-only-test", name: "gpt-pro-only-test" },
  ]);
  await modelsDb.replaceSyncedAvailableModelsForConnection(PROVIDER, plusId, [
    { id: "gpt-shared-test", name: "gpt-shared-test" },
  ]);

  if (options.proRateLimitedUntil) {
    await providersDb.updateProviderConnection(proId, {
      rateLimitedUntil: options.proRateLimitedUntil,
    });
  }

  return { proId, plusId };
}

test("Codex selects only the account whose synced inventory advertises the model", async () => {
  await resetStorage();
  const { proId, plusId } = await seedTwoAccounts();

  // Exclude pro to force the selector to look elsewhere. Plus account does not
  // advertise gpt-pro-only-test, so it must NOT be handed back.
  const selected = await auth.getProviderCredentials(PROVIDER, proId, null, "gpt-pro-only-test");

  assert.notEqual(
    selectedConnectionId(selected),
    plusId,
    "plus never synced gpt-pro-only-test and must not be selected for it"
  );
});

test("Codex does not preemptively fail over to an account lacking the model when the owner is cooling", async () => {
  await resetStorage();
  const coolingUntil = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const { plusId } = await seedTwoAccounts({ proRateLimitedUntil: coolingUntil });

  const selected = await auth.getProviderCredentials(PROVIDER, null, null, "gpt-pro-only-test");

  assert.notEqual(
    selectedConnectionId(selected),
    plusId,
    "a cooling pro must surface a cooldown, not silently route to an account without the model"
  );
});

test("Codex keeps the connection that does advertise the model selectable", async () => {
  await resetStorage();
  const { proId } = await seedTwoAccounts();

  const selected = await auth.getProviderCredentials(PROVIDER, null, null, "gpt-pro-only-test");

  assert.equal(
    selectedConnectionId(selected),
    proId,
    "pro advertises gpt-pro-only-test and must be selected"
  );
});

test("Codex a model advertised by every account leaves both connections eligible", async () => {
  await resetStorage();
  const { proId, plusId } = await seedTwoAccounts();

  const first = await auth.getProviderCredentials(PROVIDER, null, null, "gpt-shared-test");
  assert.equal(
    selectedConnectionId(first),
    proId,
    "fill-first prefers priority 1 for a shared model"
  );

  // Excluding pro (the normal account-fallback path) must still reach plus,
  // because plus genuinely advertises gpt-shared-test.
  const second = await auth.getProviderCredentials(PROVIDER, proId, null, "gpt-shared-test");
  assert.equal(
    selectedConnectionId(second),
    plusId,
    "plus advertises gpt-shared-test and must remain a valid failover"
  );
});

test("Codex does not fall back to an unsynchronized account once an inventory exists", async () => {
  await resetStorage();
  const { proId, plusId } = await seedTwoAccounts();
  await modelsDb.replaceSyncedAvailableModelsForConnection(PROVIDER, plusId, []);
  const selected = await auth.getProviderCredentials(PROVIDER, proId, null, "gpt-pro-only-test");
  assert.equal(selectedConnectionId(selected), null);
});

test("Codex preserves bootstrap selection when no account has a synced catalog", async () => {
  await resetStorage();
  const id = await createConnection({
    provider: PROVIDER,
    authType: "oauth",
    accessToken: "test-token",
    isActive: true,
  });
  assert.equal(
    selectedConnectionId(
      await auth.getProviderCredentials(PROVIDER, null, null, "gpt-shared-test")
    ),
    id
  );
});
