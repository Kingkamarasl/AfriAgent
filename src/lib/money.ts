/**
 * Money is stored and calculated as integer minor units only.
 * Floats never touch an amount -- `0.1 + 0.2 !== 0.3` is a rounding bug that
 * becomes an unreconcilable ledger entry once you bill thousands of tasks.
 */

export function formatMoney(minor: number, currency = "NGN", locale = "en-NG"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(minor / 100);
}

export function formatCompactMoney(minor: number, currency = "NGN"): string {
  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency,
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(minor / 100);
}

export function toMinor(amount: number | string): number {
  const n = typeof amount === "string" ? Number(amount) : amount;
  return Math.round(n * 100);
}
