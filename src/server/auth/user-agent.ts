/**
 * A readable "Chrome on macOS" label for a session's user agent, for the
 * profile page's session list. A rough parse on purpose: it names the common
 * browsers and systems and falls back to plain words for the rest.
 */

const BROWSERS: ReadonlyArray<[RegExp, string]> = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\/|\bOpera\b/, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bCriOS\/|\b(?:Headless)?Chrome\/|\bChromium\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];

const SYSTEMS: ReadonlyArray<[RegExp, string]> = [
  [/\biPhone\b/, "iPhone"],
  [/\biPad\b/, "iPad"],
  [/\bAndroid\b/, "Android"],
  [/\bWindows\b/, "Windows"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bLinux\b/, "Linux"],
];

function first(table: ReadonlyArray<[RegExp, string]>, text: string): string | null {
  return table.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

export function describeUserAgent(userAgent: string | null | undefined): string {
  const text = userAgent?.trim() ?? "";
  if (!text) return "Unknown device";
  const browser = first(BROWSERS, text);
  const system = first(SYSTEMS, text);
  if (browser && system) return `${browser} on ${system}`;
  if (browser) return browser;
  if (system) return `A browser on ${system}`;
  return "Unknown browser";
}
