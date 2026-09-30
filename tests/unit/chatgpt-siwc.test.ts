import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from "jose";

const dataDir = mkdtempSync(join(tmpdir(), "omniroute-siwc-"));
process.env.DATA_DIR = dataDir;
process.env.STORAGE_ENCRYPTION_KEY = "siwc-test-only-encryption-key";
process.env.JWT_SECRET = "siwc-test-only-dashboard-secret";
const { createChatGptAttempt, resolveChatGptClientId, verifyChatGptIdentity, exchangeChatGptCode } =
  await import("../../src/lib/oauth/chatgptProtocol.ts");
const { saveChatGptAttempt, claimChatGptAttempt, getChatGptAttempt, cancelChatGptAttempt } =
  await import("../../src/lib/oauth/chatgptAttempts.ts");
const { CHATGPT_PLAN_SCOPE } = await import("../../open-sse/config/chatgpt.ts");
const { ChatGptExecutor, prepareChatGptRequest } =
  await import("../../open-sse/executors/chatgpt.ts");
const { refreshChatGptToken } =
  await import("../../open-sse/services/tokenRefresh/providers/chatgpt.ts");
const { parseChatGptModels, discoverChatGptModels } =
  await import("../../src/lib/providerModels/chatgptDiscovery.ts");
const { callbackDestination } = await import("../../scripts/cli/chatgpt-login.mjs");
const { chatGptCallbackLink } = await import("../../src/shared/utils/chatgptCallback.ts");
const { getChatGptHostId } = await import("../../src/lib/db/chatgpt.ts");
const db = await import("../../src/lib/db/providers.ts");
const core = await import("../../src/lib/db/core.ts");
const { resolvePublicCred } = await import("../../open-sse/utils/publicCreds.ts");
const { getSyncedAvailableModelsForConnection } = await import("../../src/lib/db/models.ts");

test.after(() => {
  core.resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

test("management-only sign-in rejects unauthenticated and cross-origin requests and never exposes PKCE", async () => {
  const { POST } = await import("../../src/app/api/oauth/chatgpt/session/route.ts");
  const { mintDashboardSessionToken } =
    await import("../../src/shared/utils/dashboardSessionToken.ts");
  const token = await mintDashboardSessionToken(new TextEncoder().encode(process.env.JWT_SECRET));
  const request = (origin: string, authenticated: boolean, body: object) =>
    new Request("https://router.example/api/oauth/chatgpt/session", {
      method: "POST",
      headers: {
        host: "router.example",
        origin,
        "content-type": "application/json",
        ...(authenticated ? { cookie: `auth_token=${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await POST(request("https://router.example", false, { action: "start", port: 1455 }))).status,
    401
  );
  assert.equal(
    (await POST(request("https://evil.example", true, { action: "start", port: 1455 }))).status,
    403
  );
  const response = await POST(
    request("https://router.example", true, { action: "start", port: 1455 })
  );
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(Object.keys(result).sort(), ["authUrl", "expiresAt", "state"]);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const rejected = await POST(
    request("https://router.example", true, {
      action: "complete",
      state: "unknown",
      code: "secret-code",
    })
  );
  assert.equal(rejected.status, 400);
  const text = await rejected.text();
  assert.ok(!text.includes("secret-code") && !text.includes("at /"));
  await POST(request("https://router.example", true, { action: "cancel", state: result.state }));
});

test("SIWC uses independent dynamic registration, PKCE, nonce, resource and persistent host ID", () => {
  assert.match(resolvePublicCred("chatgpt_id"), /^[a-z]+_[a-z]+_[a-z]+$/);
  const host = getChatGptHostId();
  assert.equal(getChatGptHostId(), host);
  assert.match(host, /^urn:uuid:/);
  const { attempt, authUrl } = createChatGptAttempt("https://router.example", 1455, host);
  const url = new URL(authUrl);
  assert.equal(url.origin, "https://auth.openai.com");
  assert.equal(url.pathname, "/api/accounts/authorize");
  assert.equal(url.searchParams.get("client_id"), resolvePublicCred("chatgpt_id"));
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:1455/auth/callback");
  assert.equal(
    url.searchParams.get("code_challenge"),
    createHash("sha256").update(attempt.verifier).digest("base64url")
  );
  assert.equal(url.searchParams.get("resource"), "https://api.openai.com/v1");
  assert.ok(url.searchParams.get("scope")?.includes(CHATGPT_PLAN_SCOPE));
  assert.ok(!authUrl.includes(attempt.verifier));
  assert.notEqual(createChatGptAttempt(attempt.origin, 1455, host).attempt.state, attempt.state);
  assert.throws(() => resolveChatGptClientId(attempt));
  assert.throws(() => resolveChatGptClientId(attempt, resolvePublicCred("chatgpt_id")));
  assert.equal(resolveChatGptClientId(attempt, "oaiapp_example"), "oaiapp_example");
  const reused = createChatGptAttempt(attempt.origin, 1456, host, {
    clientId: "oaiapp_saved",
    subject: "user",
    connectionId: "connection",
  });
  assert.equal(new URL(reused.authUrl).searchParams.has("agent_name_hint"), false);
  assert.throws(() => resolveChatGptClientId(reused.attempt, "oaiapp_other"));
});

test("attempts are owner-bound, expiring and consumed atomically before exchange", () => {
  const { attempt } = createChatGptAttempt("https://router.example", 1455, "test-host");
  saveChatGptAttempt(attempt, "owner");
  assert.equal(getChatGptAttempt(attempt.state, "other"), null);
  assert.throws(() => claimChatGptAttempt(attempt.state, "other"));
  assert.equal(claimChatGptAttempt(attempt.state, "owner").phase, "completing");
  assert.throws(() => claimChatGptAttempt(attempt.state, "owner"));
  const expired = { ...attempt, state: "expired", expiresAt: Date.now() - 1 };
  saveChatGptAttempt(expired, "owner");
  assert.equal(getChatGptAttempt("expired", "owner"), null);
  saveChatGptAttempt({ ...attempt, state: "cancel" }, "owner");
  cancelChatGptAttempt("cancel", "owner");
  assert.equal(getChatGptAttempt("cancel", "owner"), null);
});

test("OIDC validates signature, issuer, audience, expiration and nonce", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const key = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "test" }] });
  const token = await new SignJWT({ nonce: "nonce", email: "person@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer("https://auth.openai.com")
    .setAudience("oaiapp_test")
    .setSubject("subject")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  assert.equal(
    (await verifyChatGptIdentity(token, "oaiapp_test", "nonce", key)).subject,
    "subject"
  );
  await assert.rejects(verifyChatGptIdentity(token, "oaiapp_other", "nonce", key));
  await assert.rejects(verifyChatGptIdentity(token, "oaiapp_test", "wrong", key));
  const other = await generateKeyPair("RS256");
  await assert.rejects(
    verifyChatGptIdentity(
      token,
      "oaiapp_test",
      "nonce",
      createLocalJWKSet({ keys: [{ ...(await exportJWK(other.publicKey)), kid: "test" }] })
    )
  );
});

test("callback helper and browser agree, keep code in fragment, reject untrusted schemes/origins", () => {
  const { attempt } = createChatGptAttempt("https://router.example", 1455, "host");
  const params = new URLSearchParams({
    state: attempt.state,
    code: "temporary-code",
    client_id: "oaiapp_test",
  });
  const destination = callbackDestination(attempt.origin, params);
  assert.equal(chatGptCallbackLink(params), destination);
  assert.equal(new URL(destination).search, "");
  assert.match(new URL(destination).hash, /temporary-code/);
  assert.throws(() => callbackDestination("https://evil.example", params));
  for (const origin of [
    "javascript:alert(1)",
    "http://remote.example",
    "https://user:pass@router.example",
    "https://router.example/path",
  ]) {
    const state = `siwc.${Buffer.from(origin).toString("base64url")}.${"a".repeat(43)}`;
    assert.equal(chatGptCallbackLink(new URLSearchParams({ state })), null);
    assert.throws(() => callbackDestination(origin, new URLSearchParams({ state })));
  }
});

test("request uses public Responses contract, preserves opaque items and packages client tools", async () => {
  const opaque = { type: "reasoning", encrypted_content: "opaque", id: "r1" };
  const source = {
    input: [{ role: "system", content: "instructions" }, opaque],
    tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
    temperature: 1,
    max_output_tokens: 100,
    previous_response_id: "previous",
    _secret: "internal",
  };
  const body = prepareChatGptRequest("test-model", source);
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.temperature, undefined);
  assert.equal(body.max_output_tokens, undefined);
  assert.equal(body.previous_response_id, undefined);
  assert.equal(body._secret, undefined);
  const input = body.input as Record<string, unknown>[];
  assert.equal(input[0].type, "additional_tools");
  assert.equal(input[1].role, "developer");
  assert.deepEqual(input[2], opaque);
  assert.equal(source.input[0].role, "system");
  assert.throws(() => prepareChatGptRequest("m", { tools: [{ type: "file_search" }] }));
  const executor = new ChatGptExecutor();
  assert.equal(executor.buildUrl(), "https://api.openai.com/v1/responses");
  const headers = executor.buildHeaders({ accessToken: "test-access" });
  assert.equal(headers.Authorization, "Bearer test-access");
  assert.ok(!JSON.stringify(headers).includes("codex"));
  const result = await executor.execute({ model: "m", body: {}, stream: false, credentials: {} });
  assert.ok(result instanceof Response);
  assert.equal(result.status, 403);
});

test("code exchange uses issued client and resource; refresh rotates credentials without scope widening", async (t) => {
  const { attempt } = createChatGptAttempt("https://router.example", 1455, "host");
  let form: URLSearchParams;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(String(url), "https://auth.openai.com/api/accounts/oauth/token");
    form = init.body as URLSearchParams;
    return Response.json({
      access_token: "new-access",
      refresh_token: "new-refresh",
      id_token: "id-token",
      token_type: "Bearer",
      expires_in: 3600,
      scope: CHATGPT_PLAN_SCOPE,
    });
  });
  await exchangeChatGptCode(attempt, "code", "oaiapp_test");
  assert.equal(form!.get("client_id"), "oaiapp_test");
  assert.equal(form!.get("code_verifier"), attempt.verifier);
  const result = await refreshChatGptToken({
    refreshToken: "old-refresh",
    providerSpecificData: { clientId: "oaiapp_test", subject: "s" },
  });
  assert.equal(form!.get("grant_type"), "refresh_token");
  assert.equal(form!.get("resource"), "https://api.openai.com/v1");
  assert.equal(form!.has("scope"), false);
  assert.ok(result && "accessToken" in result);
  assert.equal(result.refreshToken, "new-refresh");
  assert.ok(Date.parse(result.expiresAt) > Date.now());
  assert.equal(result.providerSpecificData?.subject, "s");
});

test("executor sends streaming public Responses requests and blocks scopes withdrawn during refresh", async (t) => {
  const { REGISTRY } = await import("../../open-sse/config/providerRegistry.ts");
  assert.equal(REGISTRY.chatgpt.forceStream, true);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls++;
    if (String(url).endsWith("/oauth/token"))
      return Response.json({
        access_token: "reduced-access",
        refresh_token: "reduced-refresh",
        expires_in: 3600,
        scope: "openid",
      });
    assert.equal(String(url), "https://api.openai.com/v1/responses");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer access");
    const body = JSON.parse(String(init.body));
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.equal(body.model, "live-model");
    return new Response(
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_test","status":"completed","output":[]}}\n\n',
      { headers: { "content-type": "text/event-stream" } }
    );
  });
  const executor = new ChatGptExecutor();
  const result = await executor.execute({
    model: "live-model",
    stream: false,
    body: { input: "Hello" },
    credentials: { accessToken: "access", providerSpecificData: { scopes: [CHATGPT_PLAN_SCOPE] } },
  });
  const response = result instanceof Response ? result : result.response;
  assert.equal(response.status, 200);
  assert.match(await response.text(), /response.completed/);
  const blocked = await executor.execute({
    model: "live-model",
    stream: true,
    body: { input: "Hello" },
    credentials: {
      accessToken: "expired",
      refreshToken: "scope-narrowing-refresh",
      expiresAt: "2020-01-01T00:00:00Z",
      providerSpecificData: { clientId: "oaiapp_scope", scopes: [CHATGPT_PLAN_SCOPE] },
    },
  });
  assert.ok(blocked instanceof Response);
  assert.equal(blocked.status, 403);
  assert.equal(calls, 2, "one inference plus one refresh; no inference after scope withdrawal");
});

test("catalog respects account visibility/order; same-email registrations remain separate and empty sync clears inventory", async (t) => {
  const payload = {
    models: [
      { slug: "second", visibility: "list", display_name: "Second" },
      { slug: "hidden", visibility: "hide" },
      { slug: "first", visibility: "list" },
    ],
  };
  assert.deepEqual(
    parseChatGptModels(payload).map((m) => m.id),
    ["second", "first"]
  );
  assert.deepEqual(parseChatGptModels({ models: [] }), []);
  assert.throws(() => parseChatGptModels({ data: [] }));
  const common = {
    provider: "chatgpt",
    authType: "oauth",
    email: "same@example.com",
    accessToken: "test-access",
    refreshToken: "test-refresh",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    providerSpecificData: {
      issuer: "https://auth.openai.com",
      subject: "user",
      clientId: "oaiapp_one",
      scopes: [CHATGPT_PLAN_SCOPE],
    },
  };
  const first = await db.createProviderConnection(common);
  const second = await db.createProviderConnection({
    ...common,
    providerSpecificData: { ...common.providerSpecificData, clientId: "oaiapp_two" },
  });
  assert.notEqual(first.id, second.id);
  assert.equal((await db.createProviderConnection(common)).id, first.id);
  let empty = false;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(String(url), "https://api.openai.com/v1/models");
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer test-access");
    return Response.json(empty ? { models: [] } : payload);
  });
  await discoverChatGptModels(first);
  assert.equal(
    (await getSyncedAvailableModelsForConnection("chatgpt", String(first.id))).length,
    2
  );
  empty = true;
  await discoverChatGptModels(first);
  assert.equal(
    (await getSyncedAvailableModelsForConnection("chatgpt", String(first.id))).length,
    0
  );
  await assert.rejects(discoverChatGptModels({ ...first, providerSpecificData: { scopes: [] } }));
});
