/** Cost display: cents under a dollar ("3¢"), dollars above ("$1.20"). */
export function fmtCost(c: number): string {
  return c >= 0.995 ? `$${c.toFixed(2)}` : `${Math.max(1, Math.round(c * 100))}¢`;
}
