import type { ListByOwnerCursor } from "./repositories.repository";

/** Opaque keyset cursor over `(updated_at DESC, id DESC)` — base64 so it's a single URL-safe query param. */
export function encodeCursor(row: { updated_at: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ updatedAt: row.updated_at.toISOString(), id: row.id })).toString("base64url");
}

export function decodeCursor(cursor: string): ListByOwnerCursor {
  const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { updatedAt: string; id: string };
  return { updatedAt: new Date(parsed.updatedAt), id: parsed.id };
}
