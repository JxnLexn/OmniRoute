// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import ChatGptOAuthModal from "@/shared/components/ChatGptOAuthModal";

vi.mock("@/shared/components/Modal", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const callback =
  "http://127.0.0.1:1455/auth/callback?code=one-time-code&state=test-state&client_id=oaiapp_test";

it("offers manual paste without helper controls and completes the current attempt", async () => {
  const calls: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      return Response.json(
        body.action === "start"
          ? { state: "test-state", authUrl: "https://auth.openai.com/fixture" }
          : { success: true, warning: "Catalog retry needed" }
      );
    })
  );
  const success = vi.fn();
  render(<ChatGptOAuthModal isOpen onClose={vi.fn()} onSuccess={success} />);
  expect(await screen.findByRole("link", { name: "Continue with ChatGPT" })).toHaveAttribute(
    "href",
    "https://auth.openai.com/fixture"
  );
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.queryByText("Download sign-in helper")).toBeNull();
  const field = screen.getByRole("textbox", { name: "Callback URL" });
  fireEvent.change(field, { target: { value: callback.replace("test-state", "wrong-state") } });
  fireEvent.click(screen.getByRole("button", { name: "Complete sign-in" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("this sign-in attempt");
  expect(calls).toHaveLength(1);
  fireEvent.change(field, { target: { value: callback } });
  fireEvent.click(screen.getByRole("button", { name: "Complete sign-in" }));
  expect(await screen.findByRole("status")).toHaveTextContent("ChatGPT is connected");
  expect(calls[1]).toEqual({ action: "complete-url", state: "test-state", callbackUrl: callback });
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.getByText("Catalog retry needed")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(success).toHaveBeenCalledOnce();
});

it("cancels a pending attempt on close", async () => {
  const fetcher = vi.fn(async (_url, init) =>
    Response.json(
      JSON.parse(init.body).action === "start"
        ? { state: "test-state", authUrl: "https://auth.openai.com/fixture" }
        : { phase: "expired" }
    )
  );
  vi.stubGlobal("fetch", fetcher);
  const view = render(<ChatGptOAuthModal isOpen onClose={vi.fn()} onSuccess={vi.fn()} />);
  await screen.findByRole("link");
  view.unmount();
  await waitFor(() =>
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/oauth/chatgpt/session",
      expect.objectContaining({ body: JSON.stringify({ action: "cancel", state: "test-state" }) })
    )
  );
});
