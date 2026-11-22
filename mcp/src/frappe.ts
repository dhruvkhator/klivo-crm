import { config } from "./config.js";

/** Error carrying a readable message extracted from Frappe's error payload. */
export class FrappeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | undefined>;

/**
 * Calls the Frappe REST API as the signed-in user (their OAuth access token),
 * so Frappe applies that user's roles and permissions to every request.
 */
export async function frappeRequest<T = unknown>(
  token: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  options: { query?: Query; body?: unknown; form?: FormData; timeoutMs?: number } = {},
): Promise<T> {
  const url = new URL(path, config.frappeUrl);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    // FormData sets its own multipart Content-Type with boundary.
    body: options.form ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
    signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
  });

  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new FrappeError(`Frappe returned non-JSON (HTTP ${res.status})`, res.status);
  }

  if (!res.ok) throw new FrappeError(readFrappeError(json, res.status), res.status);
  return json as T;
}

/** Downloads a file (e.g. a private File's file_url) as the signed-in user. */
export async function frappeDownload(token: string, fileUrl: string): Promise<Buffer> {
  const url = new URL(fileUrl, config.frappeUrl);
  if (url.origin !== new URL(config.frappeUrl).origin) throw new FrappeError("File must be on the CRM", 400);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new FrappeError(`Could not download ${fileUrl} (HTTP ${res.status})`, res.status);
  return Buffer.from(await res.arrayBuffer());
}

/** Frappe hides the human message inside `_server_messages` (a JSON string of JSON strings). */
function readFrappeError(json: any, status: number): string {
  const parts: string[] = [];
  if (typeof json?._server_messages === "string") {
    try {
      for (const raw of JSON.parse(json._server_messages) as string[]) {
        const msg = JSON.parse(raw)?.message;
        if (msg) parts.push(stripHtml(String(msg)));
      }
    } catch {
      /* ignore malformed server messages */
    }
  }
  if (!parts.length && json?.exception) parts.push(String(json.exception).split("\n")[0]);
  if (!parts.length && json?.exc_type) parts.push(String(json.exc_type));
  const prefix =
    status === 403 ? "Permission denied" : status === 404 ? "Not found" : `Frappe error (HTTP ${status})`;
  return parts.length ? `${prefix}: ${parts.join(" | ")}` : prefix;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, "").trim();
}
