import { z } from "zod";
import { CHATGPT_RESOURCE, CHATGPT_TOKEN_URL } from "../../../config/chatgpt.ts";
import { runWithProxyContext } from "../../../utils/proxyFetch.ts";

type Credentials = { refreshToken?: string; providerSpecificData?: Record<string, unknown> };
const tokensSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive(),
  scope: z.string().optional(),
  id_token: z.string().optional(),
});

export async function refreshChatGptToken(credentials: Credentials, proxyConfig: unknown = null) {
  const clientId = credentials.providerSpecificData?.clientId;
  if (typeof clientId !== "string" || !clientId.startsWith("oaiapp_") || !credentials.refreshToken)
    return { error: "unrecoverable_refresh_error", code: "invalid_client" };
  const response = await runWithProxyContext(proxyConfig, () =>
    fetch(CHATGPT_TOKEN_URL, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: credentials.refreshToken!,
        resource: CHATGPT_RESOURCE,
      }),
    })
  );
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const code = typeof body?.error === "string" ? body.error : body?.error?.code;
    if (
      [
        "invalid_grant",
        "invalid_refresh_token",
        "token_expired",
        "refresh_token_expired",
        "refresh_token_invalidated",
        "refresh_token_reused",
        "invalid_client",
      ].includes(code)
    )
      return { error: "unrecoverable_refresh_error", code };
    // Preserve temporary failure classification without exposing token endpoint bodies.
    return { error: "temporary_refresh_error", status: response.status };
  }
  const tokens = tokensSchema.parse(await response.json());
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
    expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    ...(tokens.id_token ? { idToken: tokens.id_token } : {}),
    ...(tokens.scope !== undefined
      ? {
          providerSpecificData: {
            ...credentials.providerSpecificData,
            scopes: tokens.scope.split(/\s+/).filter(Boolean),
          },
        }
      : {}),
  };
}
