/** A 6-digit authenticator code with any spaces or dashes taken out, or null if it isn't one. */
export function normalizeTotpCode(value: string): string | null {
  const digits = value.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(digits) ? digits : null;
}

/**
 * A Better Auth backup code (`abcde-12345`, 10 letters and digits, case
 * sensitive) with spaces taken out and the dash put back if it was left out,
 * or null if it isn't one.
 */
export function normalizeBackupCode(value: string): string | null {
  const compact = value.replace(/\s/g, "");
  if (/^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/.test(compact)) return compact;
  if (/^[A-Za-z0-9]{10}$/.test(compact)) return `${compact.slice(0, 5)}-${compact.slice(5)}`;
  return null;
}
