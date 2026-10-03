import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "turn-quota-recovery-"));
process.env.DATA_DIR = dir;
const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const { lockExactModel, clearAllModelLockouts } =
  await import("../../open-sse/services/accountFallback.ts");
const { getNativeCodexTurnPin, clearNativeCodexTurnPinsForTests } =
  await import("../../open-sse/services/combo/nativeCodexTurnPin.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");
test.after(() => {
  clearAllModelLockouts();
  clearNativeCodexTurnPinsForTests();
  resetDbInstance();
  fs.rmSync(dir, { recursive: true, force: true });
});
test("same single-model native turn resumes after quota lock clears", async () => {
  const model = "codex/gpt-6-astra";
  const body = {
    stream: false,
    input: [{ role: "user", content: "hello" }],
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ thread_id: "quota-test", turn_id: "same-turn" }),
    },
  };
  const combo = {
    name: "quota-recovery",
    strategy: "priority" as const,
    models: [{ id: "one", kind: "model" as const, model, connectionId: "account", weight: 1 }],
    config: { maxRetries: 0 },
  };
  let dispatched = 0;
  const run = () =>
    handleComboChat({
      body,
      combo,
      clientManagedResponsesContext: true,
      settings: { resilienceSettings: { comboCooldownWait: { enabled: false } } },
      allCombos: null,
      log: { info() {}, warn() {}, debug() {} },
      isModelAvailable: async () => true,
      handleSingleModel: async (_body, selected) => {
        assert.equal(selected, model);
        dispatched++;
        return new Response("{}", { headers: { "x-omniroute-selected-connection-id": "account" } });
      },
    });
  assert.equal((await run()).status, 200);
  lockExactModel("codex", "account", "gpt-6-astra", "quota_exhausted", 120000);
  const limited = await run();
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("Retry-After")) > 0);
  assert.equal(dispatched, 1);
  assert.equal(getNativeCodexTurnPin(body, combo.name)?.connectionId, "account");
  clearAllModelLockouts();
  assert.equal((await run()).status, 200);
  assert.equal(dispatched, 2);
});
