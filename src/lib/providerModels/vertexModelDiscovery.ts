import { parseGeminiModelsList } from "@/lib/providerModels/geminiModelsParser";
import { parseVertexAnthropicModels } from "@/lib/providerModels/vertexAnthropicModelsParser";
import { parseVertexXaiModels } from "@/lib/providerModels/vertexXaiModelsParser";

const GOOGLE_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000";
const MAX_GOOGLE_PAGES = 20;
const VERTEX_PARTNER_PUBLISHERS = [
  { id: "anthropic", parse: parseVertexAnthropicModels },
  { id: "xai", parse: parseVertexXaiModels },
] as const;

export type VertexModelDiscoveryFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface VertexModelDiscoveryResult {
  models: unknown[];
  warning?: string;
}

function readNextPageToken(data: unknown): string | null {
  if (!data || typeof data !== "object" || !("nextPageToken" in data)) return null;
  const token = (data as { nextPageToken?: unknown }).nextPageToken;
  return typeof token === "string" && token.length > 0 ? token : null;
}

/**
 * Discover every independently-addressable Vertex catalog available to an OAuth principal.
 * One publisher failure must not discard successful results from another publisher.
 */
export async function discoverVertexModelsWithBearer(options: {
  bearerToken: string;
  fetchImpl: VertexModelDiscoveryFetch;
}): Promise<VertexModelDiscoveryResult> {
  const { bearerToken, fetchImpl } = options;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${bearerToken}`,
  };
  const models: unknown[] = [];
  let failureCount = 0;

  try {
    let pageUrl = GOOGLE_MODELS_URL;
    let pageCount = 0;
    const seenTokens = new Set<string>();

    while (pageUrl && pageCount < MAX_GOOGLE_PAGES) {
      pageCount += 1;
      const response = await fetchImpl(pageUrl, { method: "GET", headers });
      if (!response.ok) {
        failureCount += 1;
        break;
      }

      const data = await response.json();
      models.push(...parseGeminiModelsList(data));
      const nextPageToken = readNextPageToken(data);
      if (!nextPageToken || seenTokens.has(nextPageToken)) break;
      seenTokens.add(nextPageToken);
      pageUrl = `${GOOGLE_MODELS_URL}&pageToken=${encodeURIComponent(nextPageToken)}`;
    }
  } catch {
    failureCount += 1;
  }

  const partnerResults = await Promise.all(
    VERTEX_PARTNER_PUBLISHERS.map(async (publisher) => {
      try {
        const response = await fetchImpl(
          `https://aiplatform.googleapis.com/v1beta1/publishers/${publisher.id}/models?pageSize=1000`,
          { method: "GET", headers }
        );
        if (!response.ok) {
          failureCount += 1;
          return [];
        }
        return publisher.parse(await response.json());
      } catch {
        failureCount += 1;
        return [];
      }
    })
  );
  for (const partnerModels of partnerResults) models.push(...partnerModels);

  return {
    models,
    ...(failureCount > 0 && models.length > 0
      ? { warning: "Some Vertex catalogs were unavailable — imported available models" }
      : {}),
  };
}
