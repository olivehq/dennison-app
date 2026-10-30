import { encode } from "uqr";

/** The base32 secret from an `otpauth://` URI, for people who type it in instead of scanning. */
export function secretFromTotpUri(uri: string): string | null {
  try {
    return new URL(uri).searchParams.get("secret");
  } catch {
    return null;
  }
}

/** `ABCD EFGH IJKL ...`: easier to read aloud and to type. Authenticator apps ignore the spaces. */
export function groupSecret(secret: string): string {
  return secret.match(/.{1,4}/g)?.join(" ") ?? secret;
}

/** One SVG path that draws every dark module of the QR code, in a grid `size` modules wide. */
export function qrPath(text: string): { size: number; path: string } {
  const { size, data } = encode(text, { ecc: "M", border: 2 });
  let path = "";
  data.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) path += `M${x} ${y}h1v1h-1z`;
    }),
  );
  return { size, path };
}

/** The text file "Download" saves. */
export function backupCodesText(codes: readonly string[], email: string): string {
  return [
    `AW appointment matching backup codes for ${email}`,
    "",
    "Each code signs you in once when you can't use your authenticator app.",
    "Making new codes stops these from working.",
    "",
    ...codes,
    "",
  ].join("\n");
}

/** Plain-words copy for the errors the two-factor card can hit. */
export function describeTwoFactorError(error: { code?: string; message?: string; status: number }): string {
  // Better Auth allows 3 two-factor requests per 10 seconds.
  if (error.status === 429) return "Too many tries. Wait a few seconds, then try again.";
  switch (error.code) {
    case "INVALID_PASSWORD":
      return "That isn't your password. Check it and try again.";
    case "INVALID_CODE":
      return "That code didn't work. Enter the newest code from your authenticator app.";
    case "TOTP_ALREADY_ENABLED":
      return "Two-factor sign-in is already on. Reload the page to see it.";
    case "TOTP_NOT_ENABLED":
    case "TWO_FACTOR_NOT_ENABLED":
      return "Two-factor sign-in is off. Reload the page and start again.";
    default:
      if (error.status === 401) return "Your session ended. Sign in again, then retry.";
      return error.message || "Something went wrong. Try again in a moment.";
  }
}
