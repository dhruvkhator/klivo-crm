/** Phone/email normalisation used for duplicate checks and search. Default country: India (+91). */

export function digitsOnly(s: string): string {
  return s.replace(/\D/g, "");
}

/** "+91 98200 12345" / "09820012345" / "9820012345" -> "+919820012345". Returns undefined if unusable. */
export function toE164(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const s = String(raw).trim();
  if (!s) return undefined;
  const plus = s.startsWith("+") || s.startsWith("00");
  let d = digitsOnly(s);
  if (s.startsWith("00")) d = d.slice(2);
  if (plus) return d.length >= 8 && d.length <= 15 ? `+${d}` : undefined;
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (d.length === 10) return `+91${d}`;
  if (d.length === 12 && d.startsWith("91")) return `+${d}`;
  return d.length >= 8 && d.length <= 15 ? `+${d}` : undefined;
}

/** Key used to match phones: last 10 digits (so all Indian formats collide). */
export function phoneKey(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const d = digitsOnly(String(raw));
  return d.length >= 8 ? d.slice(-10) : undefined;
}

export function emailKey(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const e = String(raw).replace(/\s+/g, "").toLowerCase();
  return e.includes("@") ? e : undefined;
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** True if the text looks like a phone number (digits with optional + spaces dashes brackets). */
export function looksLikePhone(s: string): boolean {
  return /^[+\d][\d\s\-()]{5,}$/.test(s.trim()) && digitsOnly(s).length >= 6;
}

/** Minimal RFC 4180 CSV parser (quotes, escaped quotes, CRLF). First row is the header. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  const nonEmpty = rows.filter((r) => r.some((v) => v.trim() !== ""));
  if (!nonEmpty.length) return [];
  const header = nonEmpty[0].map((h) => h.trim());
  return nonEmpty.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
}

export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}
