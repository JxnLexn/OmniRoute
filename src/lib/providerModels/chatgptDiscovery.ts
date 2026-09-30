import { z } from "zod";
import { getAccessToken, runWithOnPersist } from "@omniroute/open-sse/services/tokenRefresh";
import { hasChatGptPlanScope } from "@omniroute/open-sse/config/chatgpt";
import { updateProviderConnection } from "@/lib/db/providers";
import { persistDiscoveredModels } from "./modelDiscovery";
import { runWithProxyContext } from "@omniroute/open-sse/utils/proxyFetch";
import { resolveProxyForConnection } from "@/lib/db/settings";

const catalogSchema = z.object({
  models: z.array(
    z
      .object({
        slug: z.string().min(1),
        display_name: z.string().optional(),
        visibility: z.string(),
      })
      .passthrough()
  ),
});

export function parseChatGptModels(payload: unknown) {
  return catalogSchema
    .parse(payload)
    .models.filter((m) => m.visibility === "list")
    .map((m) => ({
      ...m,
      id: m.slug,
      name: m.display_name || m.slug,
      owned_by: "chatgpt",
      apiFormat: "responses",
      // Endpoint capabilities use OmniRoute's modality vocabulary, not the upstream wire format.
      supportedEndpoints: ["chat"],
    }));
}

export async function discoverChatGptModels(connection: Record<string, unknown>) {
  let credentials: Record<string, unknown> = { ...connection, connectionId: connection.id };
  const expiry = typeof connection.expiresAt === "string" ? Date.parse(connection.expiresAt) : 0;
  if (!expiry || expiry < Date.now() + 60_000) {
    const refreshed = await runWithOnPersist(
      async (update) => {
        await updateProviderConnection(String(connection.id), update);
      },
      () => getAccessToken("chatgpt", credentials, null)
    );
    if (!refreshed || "error" in refreshed)
      throw new Error("ChatGPT credentials need reauthorization.");
    credentials = { ...credentials, ...refreshed };
  }
  const data = credentials.providerSpecificData as Record<string, unknown> | undefined;
  if (!hasChatGptPlanScope(data?.scopes)) throw new Error("ChatGPT plan usage is not authorized.");
  const proxy = await resolveProxyForConnection(String(connection.id));
  const response = await runWithProxyContext(proxy.proxy, () =>
    fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${credentials.accessToken}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    })
  );
  if (!response.ok) throw new Error(`ChatGPT live catalog unavailable (HTTP ${response.status}).`);
  const models = parseChatGptModels(await response.json());
  await persistDiscoveredModels("chatgpt", String(connection.id), models);
  return models;
}
