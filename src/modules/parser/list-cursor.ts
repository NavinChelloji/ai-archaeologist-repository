/** Opaque keyset cursor helper — base64url JSON, same shape as repositories/list-cursor.ts, generalized over the sort key's type. */
export function encodeListCursor<T extends Record<string, unknown>>(fields: T): string {
  return Buffer.from(JSON.stringify(fields)).toString("base64url");
}

export function decodeListCursor<T>(cursor: string): T {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as T;
}
