import { z } from "zod";

/** An event's look on the participant schedule page. Stored in `events.branding`. */
export type EventBranding = {
  primaryColor: string | null;
  accentColor: string | null;
  /** Storage key of the uploaded logo. */
  logoKey: string | null;
  logoType: LogoType | null;
};

export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"] as const;
export type LogoType = (typeof LOGO_TYPES)[number];

/** Phones download the logo once per upload (it is cached), but it still should stay small. */
export const LOGO_MAX_BYTES = 300 * 1024;
export const LOGO_ACCEPT = LOGO_TYPES.join(",");

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const colorField = z
  .string()
  .trim()
  .refine((value) => value === "" || HEX_COLOR.test(value), "Use a six-digit color like #1d4ed8, or leave it empty.")
  .transform((value) => value.toLowerCase());

/** The two colors as the settings form holds them. An empty string means none. */
export const brandingColorsSchema = z.object({
  primaryColor: colorField,
  accentColor: colorField,
});

export type BrandingColors = z.infer<typeof brandingColorsSchema>;

/** The file's real type from its first bytes, or null when it is not a supported logo. */
export function sniffLogoType(bytes: Uint8Array): LogoType | null {
  const startsWith = (...signature: number[]) => signature.every((byte, i) => bytes[i] === byte);
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (startsWith(0xff, 0xd8, 0xff)) return "image/jpeg";
  // "RIFF", four size bytes, then "WEBP".
  if (startsWith(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return "image/webp";
  }
  const head = new TextDecoder().decode(bytes.subarray(0, 1024));
  if (/<svg[\s>]/i.test(head)) return "image/svg+xml";
  return null;
}

function channel(hex: string, start: number): number {
  const value = parseInt(hex.slice(start, start + 2), 16) / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a `#rrggbb` color. */
function luminance(hex: string): number {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

/** Black or white, whichever reads better on a `#rrggbb` background. */
export function readableOn(hex: string): "#ffffff" | "#111111" {
  const l = luminance(hex);
  const againstWhite = 1.05 / (l + 0.05);
  const againstBlack = (l + 0.05) / (luminance("#111111") + 0.05);
  return againstWhite >= againstBlack ? "#ffffff" : "#111111";
}
