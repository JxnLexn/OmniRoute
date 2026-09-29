/** Exact Codex model ids retired after discovery merge. */
export const CODEX_DISCOVERY_EXCLUDED_IDS: ReadonlySet<string> = new Set([
  // Retired upstream: absent from every openai/codex models manifest
  // (0.153.4 / 0.155.0 / 0.157.1 / main) and rejected at inference by the
  // ChatGPT-account Codex backend with `400 The 'gpt-5.3-codex-spark' model is
  // not supported when using Codex with a ChatGPT account.` The live OAuth
  // catalog can keep returning it, so it needs an explicit retired entry
  // instead of a prefix family.
  "gpt-5.3-codex-spark",
  // Retired upstream: every manifest marks it `visibility: hide` (internal
  // auto-approval reviewer), so discovery never activates it. Advertising it
  // from the static side is what breaks: every request 400s with "Model
  // 'codex-auto-review' is not available in the active live catalog for
  // provider 'codex'."
  "codex-auto-review",
]);

/**
 * Codex model-id families retired after discovery merge. Delimiter-aware
 * matching prevents prefixes such as `gpt-5.40` from being removed.
 */
export const CODEX_DISCOVERY_EXCLUDED_ID_PREFIXES: readonly string[] = ["gpt-5.4"];

export type CodexDiscoveryModelIdentity = {
  id?: unknown;
};

export function isCodexDiscoveryModelExcluded(model: CodexDiscoveryModelIdentity): boolean {
  const id = typeof model?.id === "string" ? model.id.trim().toLowerCase() : "";
  if (!id) return true;
  if (CODEX_DISCOVERY_EXCLUDED_IDS.has(id)) return true;

  return CODEX_DISCOVERY_EXCLUDED_ID_PREFIXES.some((prefix) => {
    const normalizedPrefix = prefix.toLowerCase();
    return (
      id === normalizedPrefix ||
      id.startsWith(`${normalizedPrefix}-`) ||
      id.startsWith(`${normalizedPrefix}_`) ||
      id.startsWith(`${normalizedPrefix}.`)
    );
  });
}
