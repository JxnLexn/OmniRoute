/** Untrusted origin: the callback page requires explicit user confirmation before following. */
export function chatGptCallbackLink(params: URLSearchParams): string | null {
  try {
    const parts = (params.get("state") || "").split(".");
    if (parts.length !== 3 || parts[0] !== "siwc" || !/^[A-Za-z0-9_-]{43}$/.test(parts[2]))
      return null;
    const origin = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    const site = new URL(origin);
    if (
      site.origin !== origin ||
      (site.protocol !== "https:" &&
        !(site.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(site.hostname)))
    )
      return null;
    const callback = new URLSearchParams();
    for (const key of ["state", "code", "client_id", "error"]) {
      const value = params.get(key);
      if (value && value.length <= 8192) callback.set(key, value);
    }
    return `${origin}/dashboard/providers/chatgpt/connect#${callback}`;
  } catch {
    return null;
  }
}
