/** Cost display: cents under a dollar ("3¢"), dollars above ("$1.20"). */
export function fmtCost(c: number): string {
  return c >= 0.995 ? `$${c.toFixed(2)}` : `${Math.max(1, Math.round(c * 100))}¢`;
}

/** Token counts: "842", "12.3k", "158k", then "1.5m" past a million. */
export function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}m`;
  if (n >= 100_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}
