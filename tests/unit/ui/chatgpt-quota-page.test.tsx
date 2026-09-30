// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import ProviderLimits from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits";

vi.mock("@/store/emailPrivacyStore", () => ({
  default: (select: (state: { emailsVisible: boolean }) => unknown) =>
    select({ emailsVisible: false }),
}));
vi.mock("@/store/notificationStore", () => ({
  useNotificationStore: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/shared/hooks/useTheme", () => ({
  useTheme: () => ({ theme: "light", isDark: false }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("shows ChatGPT usage management without calling an unsupported quota endpoint", async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "/api/providers/client")
      return Response.json({
        connections: [
          {
            id: "chatgpt-quota-fixture",
            provider: "chatgpt",
            authType: "oauth",
            isActive: true,
            name: "ChatGPT test account",
            testStatus: "expired",
          },
        ],
      });
    return Response.json({ caches: {} });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<ProviderLimits />);
  expect(await screen.findByRole("link", { name: "Manage usage" })).toHaveAttribute(
    "href",
    "https://chatgpt.com/settings/usage"
  );
  expect(screen.getByText("ChatGPT plan usage")).toBeInTheDocument();
  expect(screen.getAllByLabelText("Not available")).toHaveLength(3);
  expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain(
    "/api/usage/chatgpt-quota-fixture"
  );
});
