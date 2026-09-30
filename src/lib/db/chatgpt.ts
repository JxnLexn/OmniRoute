import { randomUUID } from "node:crypto";
import { getDbInstance } from "./core";

/** Host identity survives restarts, but never follows an imported account. */
export function getChatGptHostId(): string {
  const db = getDbInstance();
  return db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO key_value (namespace, key, value) VALUES (?, ?, ?)").run(
      "chatgpt",
      "hostId",
      JSON.stringify(`urn:uuid:${randomUUID()}`)
    );
    const row = db
      .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
      .get("chatgpt", "hostId") as { value: string };
    return JSON.parse(row.value) as string;
  })();
}
