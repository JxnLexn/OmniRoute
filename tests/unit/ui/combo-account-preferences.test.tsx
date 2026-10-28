import React, { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import AccountPreferencesEditor from "../../../src/app/(dashboard)/dashboard/combos/AccountPreferencesEditor";
import type { AccountPreference } from "../../../open-sse/services/combo/accountPreferences";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Harness() {
  const [value, setValue] = useState<Record<string, AccountPreference>>({
    a: "preferred",
    b: "reserve",
  });
  return (
    <>
      <AccountPreferencesEditor value={value} onChange={setValue} />
      <output data-testid="value">{JSON.stringify(value)}</output>
    </>
  );
}

function choose(element: HTMLElement, value: string, label: string) {
  if (element.tagName === "SELECT") {
    fireEvent.change(element, { target: { value } });
  } else {
    fireEvent.keyDown(element, { key: "Enter" });
    fireEvent.click(screen.getByRole("option", { name: label }));
  }
}

it("edits several accounts independently and clears only the account restored to normal", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        connections: [
          { id: "a", provider: "openai", name: "A" },
          { id: "b", provider: "openai", name: "B" },
          { id: "c", provider: "openai", name: "C" },
        ],
      }),
    })
  );
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: /Account preferences/ }));
  const first = await screen.findByRole("combobox", { name: "openai · A" });
  const third = await screen.findByRole("combobox", { name: "openai · C" });
  choose(third, "preferred", "Preferred");
  expect(JSON.parse(screen.getByTestId("value").textContent!)).toEqual({
    a: "preferred",
    b: "reserve",
    c: "preferred",
  });
  choose(first, "normal", "Normal");
  expect(JSON.parse(screen.getByTestId("value").textContent!)).toEqual({
    b: "reserve",
    c: "preferred",
  });
});

it("reports a failed account load without erasing stored preferences", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: /Account preferences/ }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(JSON.parse(screen.getByTestId("value").textContent!)).toEqual({
    a: "preferred",
    b: "reserve",
  });
});
