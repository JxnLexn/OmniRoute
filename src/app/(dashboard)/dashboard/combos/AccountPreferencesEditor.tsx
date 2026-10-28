"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import Select from "@/shared/components/Select";
import CollapsibleSection from "@/shared/components/CollapsibleSection";
import {
  readAccountPreferences,
  type AccountPreference,
} from "@omniroute/open-sse/services/combo/accountPreferences";

type Connection = {
  id: string;
  provider: string;
  name?: string;
  email?: string;
  isActive?: boolean;
};

export default function AccountPreferencesEditor({
  value,
  onChange,
  disabled = false,
}: {
  value: unknown;
  onChange: (value: Record<string, AccountPreference>) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("accountPreferences");
  const [connections, setConnections] = useState<Connection[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const preferences = readAccountPreferences(value);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/providers", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("provider-list");
        const body = await response.json();
        if (!Array.isArray(body.connections)) throw new Error("provider-list");
        if (!controller.signal.aborted) {
          setConnections(body.connections);
          setState("ready");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setState("error");
      });
    return () => controller.abort();
  }, []);

  const ids = new Set(connections.map((connection) => connection.id));
  const rows: Connection[] = [
    ...connections,
    ...Object.keys(preferences)
      .filter((id) => !ids.has(id))
      .map((id) => ({
        id,
        provider: "",
        name: t("missing", { id }),
      })),
  ];
  return (
    <CollapsibleSection
      title={t("title")}
      defaultOpen={false}
      count={Object.keys(preferences).length}
    >
      <p className="mb-3 text-xs text-text-muted">{t("description")}</p>
      {state === "loading" && <p role="status">{t("loading")}</p>}
      {state === "error" && <p role="alert">{t("error")}</p>}
      <div className="space-y-3">
        {rows.map((connection) => {
          const label = [connection.provider, connection.name || connection.email || connection.id]
            .filter(Boolean)
            .join(" · ");
          return (
            <Select
              key={connection.id}
              label={label}
              value={preferences[connection.id] || "normal"}
              disabled={disabled}
              options={["preferred", "normal", "reserve", "excluded"].map((tier) => ({
                value: tier,
                label: t(tier),
              }))}
              onChange={(event) => {
                const next = { ...preferences };
                const tier = event.target.value as AccountPreference;
                if (tier === "normal") delete next[connection.id];
                else next[connection.id] = tier;
                onChange(next);
              }}
            />
          );
        })}
      </div>
    </CollapsibleSection>
  );
}
