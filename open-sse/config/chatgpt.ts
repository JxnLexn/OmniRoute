/** Official Sign in with ChatGPT plan usage, deliberately separate from Codex. */
export const CHATGPT_ISSUER = "https://auth.openai.com";
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
export const CHATGPT_TOKEN_URL = `${CHATGPT_ISSUER}/api/accounts/oauth/token`;
export const CHATGPT_PLAN_SCOPE = "chatgpt.tokens.use.direct";
export const CHATGPT_SCOPES = `openid profile email offline_access resource.invoke ${CHATGPT_PLAN_SCOPE}`;

export function hasChatGptPlanScope(scopes: unknown): boolean {
  return Array.isArray(scopes) && scopes.includes(CHATGPT_PLAN_SCOPE);
}
