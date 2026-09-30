"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Modal from "./Modal";
import Button from "./Button";
import ChatGptSignInButton from "./ChatGptSignInButton";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  reauthConnection?: { id: string } | null;
};
async function session(body: Record<string, unknown>) {
  const response = await fetch("/api/oauth/chatgpt/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || "Unable to connect to OmniRoute.");
  return result;
}

const subscribeOrigin = () => () => {};
const browserOrigin = () => window.location.origin;
export default function ChatGptOAuthModal(props: Props) {
  const origin = useSyncExternalStore(subscribeOrigin, browserOrigin, () => "");
  return props.isOpen && origin ? <ChatGptOAuthDialog {...props} origin={origin} /> : null;
}

function ChatGptOAuthDialog({
  isOpen,
  onClose,
  onSuccess,
  reauthConnection,
  origin,
}: Props & { origin: string }) {
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname);
  const [mode, setMode] = useState(local ? "local" : "helper");
  const [port, setPort] = useState(local ? Number(new URL(origin).port || 20128) : 1455);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [attempt, setAttempt] = useState<{ state: string; authUrl: string } | null>(null);
  const stateRef = useRef<string | null>(null);
  const [done, setDone] = useState(false);
  useEffect(() => {
    return () => {
      const state = stateRef.current;
      stateRef.current = null;
      if (state) void session({ action: "cancel", state }).catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!isOpen || !attempt || done) return;
    let stopped = false;
    const timer = setInterval(() => {
      void session({ action: "status", state: attempt.state })
        .then((result) => {
          if (stopped) return;
          if (result.phase === "done") {
            setDone(true);
            setWarning(result.warning || "");
          }
          if (result.phase === "failed" || result.phase === "expired") {
            setError("Sign-in failed or expired. Start a new sign-in below.");
            setAttempt(null);
          }
        })
        .catch(() => {
          if (!stopped)
            setError("Unable to check sign-in status. Check your dashboard connection.");
        });
    }, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [isOpen, attempt, done]);

  async function start() {
    setBusy(true);
    setError("");
    try {
      if (stateRef.current) await session({ action: "cancel", state: stateRef.current });
      const result = await session({ action: "start", port, connectionId: reauthConnection?.id });
      stateRef.current = result.state;
      setAttempt(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in could not be started.");
    } finally {
      setBusy(false);
    }
  }
  const command = `node ./chatgpt-login.mjs --origin '${origin}' --port ${port}`;
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Connect ChatGPT"
      size="full"
      className="max-h-[90vh] overflow-y-auto"
    >
      <div className="space-y-6">
        <p className="text-text-muted">
          Official Sign in with ChatGPT · Preview. Uses your ChatGPT plan through the public OpenAI
          API. This is separate from the Codex provider and does not grant access to your chats.
        </p>
        <p className="rounded-lg border border-border p-3 text-sm">
          For your personal, self-hosted instance. OpenAI eligibility and app-specific usage limits
          apply. Shared or commercial services may require separate approval.
        </p>
        {done ? (
          <div className="space-y-4">
            <p role="status">ChatGPT is connected.</p>
            {warning && <p className="rounded-lg border border-amber-500 p-3">{warning}</p>}
            <Button onClick={onSuccess}>Done</Button>
          </div>
        ) : (
          <>
            <label className="block space-y-2">
              <span>Where is OmniRoute running?</span>
              <select
                className="w-full rounded-lg border border-border bg-bg-input p-3"
                value={mode}
                disabled={!!attempt}
                onChange={(event) => {
                  setMode(event.target.value);
                  setPort(
                    event.target.value === "local" ? Number(new URL(origin).port || 20128) : 1455
                  );
                }}
              >
                {local && <option value="local">On this computer</option>}
                <option value="helper">On a server — local sign-in helper</option>
                <option value="ssh">On a server — SSH tunnel</option>
              </select>
            </label>
            <label className="block space-y-2">
              <span>Local callback port</span>
              <input
                className="w-32 rounded-lg border border-border bg-bg-input p-3"
                type="number"
                min={1024}
                max={65535}
                value={port}
                disabled={!!attempt}
                onChange={(e) => setPort(Number(e.target.value))}
              />
            </label>
            {mode === "helper" && (
              <div className="space-y-3 rounded-lg border border-border p-4">
                <h3 className="font-semibold">1. Start the helper on this computer</h3>
                <p className="text-sm text-text-muted">
                  Requires Node.js 20 or newer. Download the helper, then run this command from your
                  downloads folder. Leave it running during sign-in.
                </p>
                <a
                  href="/api/oauth/chatgpt/helper"
                  download="chatgpt-login.mjs"
                  className="text-primary underline"
                >
                  Download sign-in helper
                </a>
                <pre className="overflow-x-auto rounded bg-bg-input p-3 text-sm">
                  <code>{command}</code>
                </pre>
                <p className="text-sm text-text-muted">
                  It listens only on 127.0.0.1 and never receives your access or refresh tokens.
                </p>
              </div>
            )}
            {mode === "ssh" && (
              <div className="space-y-3 rounded-lg border border-border p-4">
                <h3 className="font-semibold">1. Open an SSH tunnel on this computer</h3>
                <pre className="overflow-x-auto rounded bg-bg-input p-3 text-sm">
                  <code>{`ssh -N -L 127.0.0.1:${port}:127.0.0.1:20128 user@your-server`}</code>
                </pre>
                <p className="text-sm text-text-muted">
                  Replace user@your-server with your SSH destination, and 20128 with the
                  server&apos;s OmniRoute port if different. Keep the tunnel open. Do not run the
                  helper on the same port.
                </p>
              </div>
            )}
            {mode === "local" && (
              <p className="text-sm text-text-muted">
                The callback must reach OmniRoute over HTTP at 127.0.0.1 on this port. For an
                HTTPS-only local installation, use the helper instead.
              </p>
            )}
            <div className="space-y-3">
              <h3 className="font-semibold">
                {mode === "local" ? "Sign in" : "2. Sign in and return to OmniRoute"}
              </h3>
              <p className="text-sm text-text-muted">
                Allow ChatGPT plan usage if you want to run models. After the local callback opens,
                click Continue to OmniRoute to finish. No tokens need to be copied.
              </p>
              {!attempt ? (
                <ChatGptSignInButton
                  onClick={start}
                  busy={busy}
                  disabled={port < 1024 || port > 65535}
                />
              ) : (
                <>
                  <ChatGptSignInButton href={attempt.authUrl} />
                  <p role="status" className="text-sm text-text-muted">
                    Waiting for sign-in. This attempt expires after 10 minutes.
                  </p>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      void session({ action: "cancel", state: attempt.state });
                      setAttempt(null);
                    }}
                  >
                    Start over
                  </Button>
                </>
              )}
            </div>
            {error && (
              <p role="alert" className="rounded-lg border border-red-500 p-3 text-red-400">
                {error}
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
