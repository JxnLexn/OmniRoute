import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ProviderAccountRoutingCard from "../../../src/app/(dashboard)/dashboard/settings/components/ProviderAccountRoutingCard";
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@/shared/components", () => ({
  Input: () => null,
  Select: ({
    label,
    value,
    onChange,
    options,
  }: {
    label: string;
    value: string;
    onChange: React.ChangeEventHandler<HTMLSelectElement>;
    options: { value: string; label: string }[];
  }) => (
    <select aria-label={label} value={value} onChange={onChange}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("offers cache-aware, explains it and saves only this provider's override", async () => {
  const fetcher = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      settingsRevision: 4,
      providerStrategies: { claude: { fallbackStrategy: "priority" } },
    }),
  });
  vi.stubGlobal("fetch", fetcher);
  render(<ProviderAccountRoutingCard providerKey="openai" connectionCount={2} />);
  await screen.findByRole("option", { name: "cache-aware" });
  await waitFor(() => expect(fetcher).toHaveBeenCalled());
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "cache-aware" } });
  expect(await screen.findByText("cacheAwareAccountDesc")).toBeTruthy();
  await waitFor(() =>
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true)
  );
  const patch = fetcher.mock.calls.find(([, init]) => init?.method === "PATCH")![1];
  expect(JSON.parse(patch.body)).toEqual({
    expectedRevision: 4,
    providerStrategies: {
      claude: { fallbackStrategy: "priority" },
      openai: { fallbackStrategy: "cache-aware" },
    },
  });
});
