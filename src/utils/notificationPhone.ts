import { parsePhoneNumber } from "./phoneNumber";

/** Explicit section and account choices always take priority over a saved fallback. */
export function resolveNotificationPhone({
  sectionPhone,
  accountPhone,
  savedPhone,
}: {
  sectionPhone?: string | null;
  accountPhone?: string | null;
  savedPhone?: string | null;
}): string | null {
  return (
    parsePhoneNumber(sectionPhone || "") ?? parsePhoneNumber(accountPhone || "") ?? parsePhoneNumber(savedPhone || "")
  );
}
