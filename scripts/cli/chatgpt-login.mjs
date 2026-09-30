#!/usr/bin/env node
// Local code-only loopback relay. Access/refresh tokens never reach this helper.
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

export function callbackDestination(origin, params) {
  const site = new URL(origin);
  if (
    site.origin !== origin ||
    (site.protocol !== "https:" &&
      !(site.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(site.hostname)))
  )
    throw new Error("Use an HTTPS dashboard origin (or localhost).");
  const parts = (params.get("state") || "").split(".");
  if (
    parts.length !== 3 ||
    parts[0] !== "siwc" ||
    Buffer.from(parts[1], "base64url").toString("utf8") !== origin ||
    !/^[A-Za-z0-9_-]{43}$/.test(parts[2])
  )
    throw new Error("This callback does not belong to the configured dashboard.");
  const callback = new URLSearchParams();
  for (const key of ["state", "code", "client_id", "error"]) {
    const value = params.get(key);
    if (value && value.length <= 8192) callback.set(key, value);
  }
  return `${origin}/dashboard/providers/chatgpt/connect#${callback}`;
}
function escapeHtml(value) {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}
export function startRelay(origin, port = 1455) {
  callbackDestination(
    origin,
    new URLSearchParams({
      state: `siwc.${Buffer.from(origin).toString("base64url")}.${"a".repeat(43)}`,
    })
  );
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid port");
  const server = createServer((request, response) => {
    const headers = {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
    };
    if (request.headers.host !== `127.0.0.1:${port}` || request.method !== "GET") {
      response.writeHead(400, headers).end("Invalid callback request.");
      return;
    }
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (url.pathname !== "/auth/callback") {
      response.writeHead(404, headers).end("Not found.");
      return;
    }
    try {
      const destination = callbackDestination(origin, url.searchParams);
      response
        .writeHead(200, headers)
        .end(
          `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Continue to OmniRoute</title><h1>Return to OmniRoute</h1><p>Continue to your dashboard at ${escapeHtml(origin)} to finish signing in.</p><p><a rel="noreferrer" href="${escapeHtml(destination)}">Continue to OmniRoute</a></p><p>This helper handles only the temporary sign-in code. It does not receive or store access tokens. You can stop it after completing sign-in.</p></html>`
        );
    } catch {
      response.writeHead(400, headers).end("Invalid callback. Start sign-in again in OmniRoute.");
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.listen(port, "127.0.0.1");
  const timeout = setTimeout(() => server.close(), 15 * 60_000);
  timeout.unref();
  server.on("close", () => clearTimeout(timeout));
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const origin = args[args.indexOf("--origin") + 1];
  const portIndex = args.indexOf("--port");
  try {
    if (!args.includes("--origin")) throw new Error("Pass --origin https://your-omniroute.example");
    const server = startRelay(origin, portIndex >= 0 ? Number(args[portIndex + 1]) : 1455);
    server.on("listening", () =>
      console.log(
        "ChatGPT callback helper is ready. Continue sign-in in OmniRoute. Expires after 15 minutes."
      )
    );
    server.on("error", () => {
      console.error(
        "Cannot bind the callback port. Close other login helpers or choose another port."
      );
      process.exitCode = 1;
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
