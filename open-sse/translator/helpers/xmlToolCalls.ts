/** Parse textual tool calls while retaining incomplete bodies across chunks. */
export function extractXmlInvokeBlocks(
  text: string,
  state: { _xmlInvokeBuffer?: string }
): {
  cleaned: string;
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
} {
  const toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
  const combined = (state._xmlInvokeBuffer || "") + text;
  state._xmlInvokeBuffer = "";
  let remaining = combined;
  let cleaned = "";

  while (remaining.length > 0) {
    const invokeMatch = remaining.match(/<invoke\s+name="([^"]*)"\s*>/);
    const toolCallTagMatch = remaining.match(/<tool_call>/);
    const toolCallTextMatch = remaining.match(/TOOL_CALL\s+([A-Za-z0-9_]+):\s*/);

    const matches = [
      invokeMatch
        ? { type: "invoke" as const, index: invokeMatch.index!, data: invokeMatch }
        : null,
      toolCallTagMatch
        ? { type: "tool_call_tag" as const, index: toolCallTagMatch.index!, data: toolCallTagMatch }
        : null,
      toolCallTextMatch
        ? {
            type: "tool_call_text" as const,
            index: toolCallTextMatch.index!,
            data: toolCallTextMatch,
          }
        : null,
    ]
      .filter(Boolean)
      .sort((a, b) => a!.index - b!.index);

    if (matches.length === 0) {
      cleaned += remaining;
      break;
    }

    const first = matches[0]!;
    cleaned += remaining.slice(0, first.index);
    const rest = remaining.slice(first.index);

    if (first.type === "invoke") {
      const startMatch = first.data;
      const endMatch = rest.match(/<\/invoke>/);
      if (!endMatch) {
        state._xmlInvokeBuffer = rest;
        break;
      }
      const innerXml = rest.slice(startMatch[0].length, endMatch.index!);
      const fullLength = endMatch.index! + endMatch[0].length;
      const args: Record<string, string> = {};
      const paramRegex = /<parameter\s+name="([^"]*)"[^>]*>([\s\S]*?)<\/parameter>/g;
      let pm;
      while ((pm = paramRegex.exec(innerXml)) !== null) {
        args[pm[1]] = pm[2].trim();
      }
      toolCalls.push({
        id: `toolu_xml_${Date.now()}_${toolCalls.length}`,
        name: startMatch[1],
        args,
      });
      remaining = rest.slice(fullLength);
    } else if (first.type === "tool_call_tag") {
      const endMatch = rest.match(/<\/tool_call>/);
      if (!endMatch) {
        state._xmlInvokeBuffer = rest;
        break;
      }
      const innerJson = rest.slice("<tool_call>".length, endMatch.index!).trim();
      const fullLength = endMatch.index! + "</tool_call>".length;
      try {
        const parsed = JSON.parse(innerJson) as Record<string, unknown>;
        const name = (parsed.name || parsed.tool_name || "") as string;
        const rawArgs = parsed.arguments || parsed.args || parsed.parameters || {};
        const args: Record<string, unknown> =
          typeof rawArgs === "string" ? JSON.parse(rawArgs) : (rawArgs as Record<string, unknown>);
        if (name) {
          toolCalls.push({ id: `toolu_txt_${Date.now()}_${toolCalls.length}`, name, args });
        }
      } catch {
        cleaned += rest.slice(0, fullLength);
      }
      remaining = rest.slice(fullLength);
    } else {
      const startMatch = first.data;
      const toolName = startMatch[1];
      const afterPrefix = rest.slice(startMatch[0].length);
      let depth = 0,
        inString = false,
        escape = false,
        jsonEndIndex = -1;
      for (let i = 0; i < afterPrefix.length; i++) {
        const c = afterPrefix[i];
        if (escape) {
          escape = false;
          continue;
        }
        if (c === "\\" && inString) {
          escape = true;
          continue;
        }
        if (c === '"') {
          inString = !inString;
          continue;
        }
        if (!inString) {
          if (c === "{") depth++;
          else if (c === "}") {
            depth--;
            if (depth === 0) {
              jsonEndIndex = i + 1;
              break;
            }
          }
        }
      }
      if (jsonEndIndex === -1) {
        state._xmlInvokeBuffer = rest;
        break;
      }
      const jsonStr = afterPrefix.slice(0, jsonEndIndex);
      const fullLength = startMatch[0].length + jsonEndIndex;
      try {
        const args = JSON.parse(jsonStr) as Record<string, unknown>;
        toolCalls.push({ id: `toolu_txt_${Date.now()}_${toolCalls.length}`, name: toolName, args });
      } catch {
        cleaned += rest.slice(0, fullLength);
      }
      remaining = rest.slice(fullLength);
    }
  }

  return { cleaned, toolCalls };
}
