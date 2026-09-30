"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

export default function ChatGptConnectPage() {
  const started = useRef(false);
  const [message, setMessage] = useState("Completing ChatGPT sign-in…");
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(window.location.hash.slice(1));
    window.history.replaceState(null, "", window.location.pathname);
    if (params.has("error") || !params.get("code") || !params.get("state")) {
      queueMicrotask(() =>
        setMessage(
          "Sign-in was cancelled or the callback is incomplete. Start again in ChatGPT settings."
        )
      );
      return;
    }
    void fetch("/api/oauth/chatgpt/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "complete",
        state: params.get("state"),
        code: params.get("code"),
        clientId: params.get("client_id") || undefined,
      }),
    })
      .then(async (response) => {
        const result = await response.json();
        setMessage(
          response.ok
            ? result.warning || "ChatGPT is connected. You can return to the original tab."
            : result.error?.message || "Sign-in failed. Start again from your dashboard."
        );
      })
      .catch(() => setMessage("Unable to reach OmniRoute. Start sign-in again."));
  }, []);
  return (
    <main className="mx-auto max-w-2xl space-y-6 p-8">
      <h1 className="text-2xl font-semibold">ChatGPT</h1>
      <p role="status">{message}</p>
      <Link href="/dashboard/providers/chatgpt" className="text-primary underline">
        Back to ChatGPT
      </Link>
    </main>
  );
}
