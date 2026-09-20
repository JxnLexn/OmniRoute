import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { buildComboTestRequestBody } from "@/lib/combos/testHealth";
import {
  DEFAULT_MODEL_TEST_TIMEOUT_MS,
  extractModelTestResponseText,
  extractProviderErrorMessage,
  resolveModelTestTimeoutMs,
} from "@/lib/api/modelTestRunner";
import { getComboByName, getCombos, pickApiKeyForInternalUse } from "@/lib/localDb";
import { getRuntimePorts } from "@/lib/runtime/ports";
import { resolveNestedComboTargets } from "@omniroute/open-sse/services/combo.ts";
import { testComboSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

async function getInternalApiKey(): Promise<string | null> {
  // Combo health-check probes hit /v1/chat/completions, which enforces
  // per-key model allowlists (see shared/utils/apiKeyPolicy.ts). Picking
  // an arbitrary active key is unsafe — see pickApiKeyForInternalUse.
  return pickApiKeyForInternalUse("combo-health-check");
}

function buildComboTestResult(target, partial = {}) {
  return {
    model: target.modelStr,
    provider: target.provider,
    stepId: target.stepId,
    executionKey: target.executionKey,
    connectionId: target.connectionId,
    label: target.label,
    ...partial,
  };
}

async function testComboTarget(target, baseInternalUrl, internalApiKey: string | null) {
  const startTime = Date.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let timeoutMs = DEFAULT_MODEL_TEST_TIMEOUT_MS;
  try {
    // Issue #2359: combo entries with a malformed/missing modelStr surfaced
    // as `e.startsWith is not a function` / similar TypeError 500s. Coerce
    // defensively at the boundary so the test path returns a clean error
    // instead of crashing the request handler.
    const modelStr = typeof target?.modelStr === "string" ? target.modelStr : "";
    if (!modelStr) {
      return buildComboTestResult(target, {
        status: "error",
        error: "Combo step is missing a model id (modelStr). Re-save the combo to refresh it.",
        latencyMs: 0,
      });
    }
    const modelLower = modelStr.toLowerCase();
    const isEmbedding =
      modelLower.includes("embedding") ||
      modelLower.includes("bge-") ||
      modelLower.includes("text-embed");
    const internalUrl = `${baseInternalUrl}/v1/${isEmbedding ? "embeddings" : "chat/completions"}`;
    const testBody = buildComboTestRequestBody(modelStr, isEmbedding, { stream: !isEmbedding });
    const provider = target.provider || modelStr.split("/")[0];
    timeoutMs = resolveModelTestTimeoutMs(
      provider,
      modelStr,
      provider === "nvidia" ? 180_000 : DEFAULT_MODEL_TEST_TIMEOUT_MS
    );

    const controller = new AbortController();
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const res = await fetch(internalUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(internalApiKey ? { Authorization: `Bearer ${internalApiKey}` } : {}),
        "X-Internal-Test": "combo-health-check",
        // Force a fresh execution path so combo tests cannot be satisfied by
        // OmniRoute's semantic cache or other request reuse layers.
        "X-OmniRoute-No-Cache": "true",
        "X-OmniRoute-Compression": "off",
        ...(target.connectionId ? { "X-OmniRoute-Connection": target.connectionId } : {}),
        "X-Request-Id": `combo-test-${randomUUID()}`,
      },
      body: JSON.stringify(testBody),
      signal: controller.signal,
    });

    if (res.ok) {
      const parsed = await extractModelTestResponseText(res, !isEmbedding);
      if (timedOut) {
        throw new Error("Model test deadline exceeded");
      }
      const latencyMs = Date.now() - startTime;
      if (parsed.error) {
        return buildComboTestResult(target, {
          status: "error",
          statusCode: parsed.error.statusCode,
          error: sanitizeErrorMessage(parsed.error.message),
          latencyMs,
        });
      }
      const responseText = parsed.text;
      if (!responseText) {
        return buildComboTestResult(target, {
          status: "error",
          statusCode: res.status,
          error: "Provider returned HTTP 200 but no text content.",
          latencyMs,
        });
      }

      return buildComboTestResult(target, { status: "ok", latencyMs, responseText });
    }

    let errorMsg = "";
    try {
      const errBody = await res.json();
      errorMsg = extractProviderErrorMessage(errBody, res.statusText);
    } catch {
      errorMsg = res.statusText;
    }

    return buildComboTestResult(target, {
      status: "error",
      statusCode: res.status,
      error: sanitizeErrorMessage(errorMsg),
      latencyMs: Date.now() - startTime,
    });
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    return buildComboTestResult(target, {
      status: "error",
      ...(timedOut ? { statusCode: 504, isTimeout: true } : {}),
      error: timedOut
        ? `No model output within ${Math.round(timeoutMs / 1000)}s`
        : error.name === "AbortError"
          ? "Model test aborted"
          : sanitizeErrorMessage(error.message),
      latencyMs,
    });
  } finally {
    // Keep the deadline alive through SSE/JSON body consumption, not just headers.
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * POST /api/combos/test - Quick test a combo
 * Sends a real chat completion request through each model in the combo
 * and only reports success when the model returns usable text content.
 */
export async function POST(request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: {
          message: "Invalid request",
          details: [{ field: "body", message: "Invalid JSON body" }],
        },
      },
      { status: 400 }
    );
  }

  try {
    const validation = validateBody(testComboSchema, rawBody);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const { comboName } = validation.data;

    const combo = await getComboByName(comboName);
    if (!combo) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    const allCombos = await getCombos();
    const targets = resolveNestedComboTargets(combo, allCombos);

    if (targets.length === 0) {
      return NextResponse.json({ error: "Combo has no models" }, { status: 400 });
    }

    const baseInternalUrl = getInternalBaseUrl();
    const internalApiKey = await getInternalApiKey();
    const results = await Promise.all(
      targets.map((target) => testComboTarget(target, baseInternalUrl, internalApiKey))
    );
    const resolvedResult = results.find((result) => result.status === "ok") || null;
    const resolvedBy = resolvedResult?.model || null;

    return NextResponse.json({
      comboName,
      strategy: combo.strategy || "priority",
      testMode: "parallel-health-check",
      resolvedBy,
      resolvedByExecutionKey: resolvedResult?.executionKey || null,
      resolvedByTarget: resolvedResult
        ? {
            model: resolvedResult.model,
            provider: resolvedResult.provider,
            stepId: resolvedResult.stepId,
            executionKey: resolvedResult.executionKey,
            connectionId: resolvedResult.connectionId,
            label: resolvedResult.label,
          }
        : null,
      results,
      testedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.log("Error testing combo:", error);
    return NextResponse.json({ error: "Failed to test combo" }, { status: 500 });
  }
}

function getInternalBaseUrl(): string {
  const { apiPort } = getRuntimePorts();
  return `http://127.0.0.1:${apiPort}`;
}
