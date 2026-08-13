export const PHONE_NUMBER_ERROR =
  "Enter a valid phone number, such as (213) 555-1212 or +44 20 7946 0958. Extensions are not supported.";

const US_COUNTRY_CODE = "1";

const digitsOnly = (value: string) => value.replace(/\D/g, "");
const PHONE_EXTENSION_PATTERN = /(?:\b(?:ext(?:ension)?|x)\b|#)/i;
const US_PHONE_PATTERN = /(?<!\d)(?:1[\s.-]*)?(?:\(\s*\d{3}\s*\)|\d{3})[\s.-]*\d{3}[\s.-]*\d{4}(?!\d)/g;

function parseAnnotatedUsNumber(value: string): string | null {
  if (PHONE_EXTENSION_PATTERN.test(value)) {
    return null;
  }

  const matches = [...value.matchAll(US_PHONE_PATTERN)];
  if (matches.length !== 1) {
    return null;
  }

  const match = matches[0]!;
  const remainingValue = `${value.slice(0, match.index)}${value.slice((match.index ?? 0) + match[0].length)}`;
  // Labels such as "mobile" or "text only" are harmless, but any additional
  // digits could be an extension, a second number, or a mistyped number.
  if (digitsOnly(remainingValue)) {
    return null;
  }

  const digits = digitsOnly(match[0]);
  return digits.length === 10 ? `+${US_COUNTRY_CODE}${digits}` : `+${digits}`;
}

/**
 * Accept common US formatting and explicit international E.164-style input.
 * US-local numbers may omit +1; international numbers must start with + so a
 * bare 11-15 digit value is never assigned the wrong country.
 */
export function parsePhoneNumber(value: string): string | null {
  const trimmed = value.trim().replace(/^tel:\s*/i, "");
  if (!trimmed || trimmed.length > 64) {
    return null;
  }

  if (trimmed.startsWith("+")) {
    const internationalDisplay = trimmed.slice(1);
    // A parenthesized trunk prefix is country-specific: it is omitted in some
    // countries but remains significant in others. Reject it instead of ever
    // silently changing the destination.
    if (internationalDisplay.includes("+") || /\(\s*0\s*\)/.test(internationalDisplay)) {
      return null;
    }
    const internationalDigits = digitsOnly(internationalDisplay);
    // Copy/paste and autofill can append a harmless label such as "text
    // only". Permit that for US numbers, where the country code and exact
    // digit count are unambiguous. Other countries still require only visual
    // phone separators because we cannot infer country-specific dial rules.
    if (internationalDigits.startsWith(US_COUNTRY_CODE)) {
      return parseAnnotatedUsNumber(internationalDisplay);
    }
    // Country code 1 always requires ten national digits. Do not reinterpret
    // a short or long North American number as a generic international one.
    if (!/^[\d\s().-]+$/.test(internationalDisplay)) {
      return null;
    }
    if (!/^\d{8,15}$/.test(internationalDigits) || internationalDigits.startsWith("0")) {
      return null;
    }
    return `+${internationalDigits}`;
  }

  if (trimmed.includes("+")) {
    return null;
  }
  // A US number is still unambiguous when a phone field includes a harmless
  // label, provided it contains exactly one complete number and no other digits.
  return parseAnnotatedUsNumber(trimmed);
}

export function formatPhoneNumberForDisplay(value: string): string {
  const parsed = parsePhoneNumber(value);
  if (!parsed) {
    return value;
  }
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(parsed);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : parsed;
}
