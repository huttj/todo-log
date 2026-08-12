// Wrap query matches in <mark> for search result embeds.
import type { ReactNode } from "react";

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function highlight(text: string, q?: string): ReactNode {
  const query = q?.trim();
  if (!query) return text;
  const re = new RegExp(`(${escapeRegex(query)})`, "ig");
  const parts = text.split(re);
  if (parts.length === 1) return text;
  return parts.map((p, i) =>
    p.toLowerCase() === query.toLowerCase() ? <mark key={i}>{p}</mark> : p,
  );
}
