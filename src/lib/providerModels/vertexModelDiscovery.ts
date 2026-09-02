import { parseGeminiModelsList } from "@/lib/providerModels/geminiModelsParser";
import { parseVertexPublisherModels } from "@/lib/providerModels/vertexPublisherModelsParser";

const GOOGLE_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000";
const MAX_CATALOG_PAGES = 20;

/**
 * Serverless chat publishers currently documented by Vertex Model Garden. The parser and executor
 * remain publisher-generic, so newly returned model versions need no source change.
 */
export const VERTEX_MODEL_GARDEN_PUBLISHERS = [
  "anthropic",
  "xai",
  "mistralai",
  "meta",
  "deepseek-ai",
  "qwen",
  "moonshotai",
  "minimaxai",
  "openai",
  "zai-org",
] as const;

export type VertexModelDiscoveryFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface VertexModelDiscoveryResult {
  models: unknown[];
  warning?: string;
}

interface DiscoveryAuth {
  headers: Record<string, string>;
}

function readNextPageToken(data: unknown): string | null {
  if (!data || typeof data !== "object" || !("nextPageToken" in data)) return null;
  const token = (data as { nextPageToken?: unknown }).nextPageToken;
  return typeof token === "string" && token.length > 0 ? token : null;
}

async function discoverVertexModels(options: {
  auth: DiscoveryAuth;
  fetchImpl: VertexModelDiscoveryFetch;
}): Promise<VertexModelDiscoveryResult> {
  const { auth, fetchImpl } = options;
  const models: unknown[] = [];
  let failureCount = 0;

  try {
    let pageUrl = GOOGLE_MODELS_URL;
    let pageCount = 0;
    const seenTokens = new Set<string>();

    while (pageUrl && pageCount < MAX_CATALOG_PAGES) {
      pageCount += 1;
      const response = await fetchImpl(pageUrl, { method: "GET", headers: auth.headers });
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

  const publisherResults = await Promise.all(
    VERTEX_MODEL_GARDEN_PUBLISHERS.map(async (publisher) => {
      const publisherModels: unknown[] = [];
      let pageUrl =
        `https://aiplatform.googleapis.com/v1beta1/publishers/${publisher}/models` +
        "?pageSize=1000";
      let pageCount = 0;
      const seenTokens = new Set<string>();

      try {
        while (pageUrl && pageCount < MAX_CATALOG_PAGES) {
          pageCount += 1;
          const response = await fetchImpl(pageUrl, { method: "GET", headers: auth.headers });
          if (!response.ok) {
            failureCount += 1;
            break;
          }

          const data = await response.json();
          publisherModels.push(...parseVertexPublisherModels(data, publisher));
          const nextPageToken = readNextPageToken(data);
          if (!nextPageToken || seenTokens.has(nextPageToken)) break;
          seenTokens.add(nextPageToken);
          pageUrl =
            `https://aiplatform.googleapis.com/v1beta1/publishers/${publisher}/models` +
            `?pageSize=1000&pageToken=${encodeURIComponent(nextPageToken)}`;
        }
      } catch {
        failureCount += 1;
      }

      return publisherModels;
    })
  );
  for (const publisherModels of publisherResults) models.push(...publisherModels);

  return {
    models,
    ...(failureCount > 0 && models.length > 0
      ? { warning: "Some Vertex catalogs were unavailable — imported available models" }
      : {}),
  };
}

/** Discover live Gemini and Model Garden catalogs with OAuth or Service Account credentials. */
export function discoverVertexModelsWithBearer(options: {
  bearerToken: string;
  fetchImpl: VertexModelDiscoveryFetch;
}): Promise<VertexModelDiscoveryResult> {
  return discoverVertexModels({
    auth: {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.bearerToken}`,
      },
    },
    fetchImpl: options.fetchImpl,
  });
}

/**
 * Prefer live discovery for API keys. A standard Express key will normally receive an auth error
 * from Model Garden and fall back to the curated Express catalog; a service-account-bound
 * Authorization Key can return the same publisher catalogs as a Bearer credential.
 */
export function discoverVertexModelsWithApiKey(options: {
  apiKey: string;
  fetchImpl: VertexModelDiscoveryFetch;
}): Promise<VertexModelDiscoveryResult> {
  return discoverVertexModels({
    auth: {
      // Keep the secret out of URLs and any URL-bearing error/log path.
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": options.apiKey,
      },
    },
    fetchImpl: options.fetchImpl,
  });
}
