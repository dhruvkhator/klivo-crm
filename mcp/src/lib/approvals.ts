import { randomBytes } from "node:crypto";

/**
 * One-time approval tokens for the two-step tools (send, delete, import, enabling automations).
 * Step 1 (preview) stores exactly what will happen and returns a token; step 2 runs only that,
 * only for the same CRM user, once. Tokens live in memory: a server restart simply means "preview again".
 */
interface Entry<T> {
  kind: string;
  user: string;
  payload: T;
  expires: number;
}

const store = new Map<string, Entry<unknown>>();

export function issueApproval<T>(kind: string, user: string, payload: T, ttlSeconds: number): { token: string; expires_at: string } {
  sweep();
  const token = `${kind}_${randomBytes(12).toString("hex")}`;
  const expires = Date.now() + ttlSeconds * 1000;
  store.set(token, { kind, user, payload, expires });
  return { token, expires_at: new Date(expires).toISOString() };
}

export function consumeApproval<T>(token: string, kind: string, user: string): T {
  const entry = store.get(token);
  if (!entry || entry.kind !== kind || entry.expires < Date.now()) {
    throw new Error(`Unknown or expired ${kind} token. Run the preview step again.`);
  }
  if (entry.user !== user) throw new Error("This token was issued to a different CRM user.");
  store.delete(token);
  return entry.payload as T;
}

/** Look without consuming (e.g. to show what a token covers). */
export function peekApproval<T>(token: string, kind: string, user: string): T | undefined {
  const entry = store.get(token);
  return entry && entry.kind === kind && entry.user === user && entry.expires >= Date.now() ? (entry.payload as T) : undefined;
}

function sweep() {
  const now = Date.now();
  for (const [k, v] of store) if (v.expires < now) store.delete(k);
}
