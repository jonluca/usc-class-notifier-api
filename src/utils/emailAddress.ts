import { z } from "zod/v4";

export const EMAIL_ADDRESS_ERROR = "Please enter a valid email address.";

// Keep corrections explicit: nearby domains can belong to other schools or
// businesses. These include the USC/Gmail misspellings seen in delivery bounces.
const domainCorrections = new Map([
  ["usc.du", "usc.edu"],
  ["usc.ed", "usc.edu"],
  ["usc.eu", "usc.edu"],
  ["usc.efu", "usc.edu"],
  ["usc.eud", "usc.edu"],
  ["usc.deu", "usc.edu"],
  ["usc.eduu", "usc.edu"],
  ["usc.edu.com", "usc.edu"],
  ["usc.com", "usc.edu"],
  ["uscedu", "usc.edu"],
  ["gmal.com", "gmail.com"],
  ["gamil.com", "gmail.com"],
  ["gmial.com", "gmail.com"],
  ["gmai.com", "gmail.com"],
  ["gmil.com", "gmail.com"],
  ["gnail.com", "gmail.com"],
  ["gmail.con", "gmail.com"],
  ["gmail.cmo", "gmail.com"],
  ["gmail.cm", "gmail.com"],
  ["gmail.co", "gmail.com"],
  ["gmail.comm", "gmail.com"],
  ["gmail.com.com", "gmail.com"],
  ["gmailcom", "gmail.com"],
]);

export function normalizeEmailAddress(value: string): string {
  const trimmed = value.trim();
  const parts = trimmed.split("@");
  if (parts.length !== 2) {
    return trimmed;
  }

  // Preserve the mailbox name, including case, dots and plus aliases. Guessing
  // at it could send an account's sign-in link to a different person.
  const localPart = parts[0]!.trim();
  const domain = parts[1]!.trim();
  // Existing accounts use exact email lookups. Preserve valid domain casing so
  // cleaning new input does not strand an older account on an empty dashboard.
  return `${localPart}@${domainCorrections.get(domain.toLowerCase()) ?? domain}`;
}

export const emailAddressSchema = z
  .string()
  .max(320, EMAIL_ADDRESS_ERROR)
  .transform(normalizeEmailAddress)
  .pipe(z.email({ error: EMAIL_ADDRESS_ERROR }).max(254, EMAIL_ADDRESS_ERROR))
  .refine((email) => email.indexOf("@") <= 64, EMAIL_ADDRESS_ERROR);
