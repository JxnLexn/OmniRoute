/**
 * /auth/callback — OAuth callback endpoint for providers that use the
 * `/auth/callback` path (including the Devin PKCE compatibility flow).
 *
 * Reuses the same logic as /callback:
 *  - postMessage to opener (popup mode)
 *  - BroadcastChannel (same-origin tabs)
 *  - localStorage fallback
 *
 * On true localhost the random-port callback server intercepts this path first,
 * so this page is only reached in the LAN / popup-without-callback-server case.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import CallbackPage from "@/app/callback/page";
import { chatGptCallbackLink } from "@/shared/utils/chatgptCallback";

export default function AuthCallbackPage() {
  const started = useRef(false);
  const [callback, setCallback] = useState<{ siwc: boolean; link: string | null } | null>(null);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(window.location.search);
    const siwc = params.get("state")?.startsWith("siwc.") === true;
    const link = siwc ? chatGptCallbackLink(params) : null;
    if (siwc) window.history.replaceState(null, "", window.location.pathname);
    setCallback({ siwc, link });
  }, []);
  if (!callback) return null;
  if (!callback.siwc) return <CallbackPage />;
  return (
    <main className="mx-auto max-w-xl space-y-5 p-8">
      <h1 className="text-2xl font-semibold">Continue to OmniRoute</h1>
      {callback.link ? (
        <>
          <p>Only continue if this is your OmniRoute dashboard:</p>
          <p className="break-all font-mono">{new URL(callback.link).origin}</p>
          <a
            className="inline-block rounded-lg bg-primary px-4 py-3 text-white"
            rel="noreferrer"
            href={callback.link}
          >
            Continue to OmniRoute
          </a>
        </>
      ) : (
        <p>Invalid ChatGPT callback. Start sign-in again.</p>
      )}
    </main>
  );
}
