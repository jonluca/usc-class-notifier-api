import { baseDomain } from "@/constants";

const VENMO_RECIPIENT = "JonLuca";
const PAYMENT_AMOUNT = "1.00";
export const PAYMENT_SUPPORT_EMAIL = "usc-schedule-helper@jonlu.ca";

const SEMESTER_NAMES = {
  "1": "Spring",
  "2": "Summer",
  "3": "Fall",
} as const;

export interface PaymentHelpDetails {
  paidId: string;
  section: string;
  semester: string;
  courseNumber?: string | null;
}

/** Builds the one canonical Venmo checkout URL used throughout the product. */
export function buildVenmoPaymentUrl(paidId: string): string {
  const url = new URL("https://account.venmo.com/pay");
  url.searchParams.set("recipients", VENMO_RECIPIENT);
  url.searchParams.set("amount", PAYMENT_AMOUNT);
  url.searchParams.set("note", paidId.trim());
  return url.toString();
}

/** Builds an absolute link that works from email clients as well as the web app. */
export function buildPaymentHelpUrl({ paidId, section, semester, courseNumber }: PaymentHelpDetails): string {
  const url = new URL("/payment-help", baseDomain);
  url.searchParams.set("paidId", paidId.trim());
  url.searchParams.set("section", section.trim());
  url.searchParams.set("semester", semester.trim());
  if (courseNumber?.trim()) {
    url.searchParams.set("courseNumber", courseNumber.trim());
  }
  return url.toString();
}

export function formatSemester(semester: string): string {
  const normalizedSemester = semester.trim();
  const match = /^(\d{4})([123])$/.exec(normalizedSemester);
  if (!match) {
    return normalizedSemester || "Unknown semester";
  }

  const [, year, term] = match;
  switch (term) {
    case "1":
      return `${SEMESTER_NAMES["1"]} ${year}`;
    case "2":
      return `${SEMESTER_NAMES["2"]} ${year}`;
    case "3":
      return `${SEMESTER_NAMES["3"]} ${year}`;
    default:
      return normalizedSemester;
  }
}

function cleanMailDetail(value: string, maxLength = 80): string {
  return value
    .trim()
    .replace(/[\r\n]+/g, " ")
    .slice(0, maxLength);
}

export function buildPaymentSupportMailto(details: PaymentHelpDetails): string {
  const courseNumber = details.courseNumber ? cleanMailDetail(details.courseNumber) : "Unknown course";
  const section = cleanMailDetail(details.section);
  const semester = formatSemester(cleanMailDetail(details.semester));
  const paidId = cleanMailDetail(details.paidId);
  const query = new URLSearchParams({
    subject: `Venmo payment help — ${courseNumber}, section ${section}`,
    body: [
      "Hi, I need help matching a $1.00 Venmo payment to my USC Schedule Helper section.",
      "",
      `Course: ${courseNumber}`,
      `Section: ${section}`,
      `Semester: ${semester}`,
      `Required payment note: ${paidId}`,
      "",
      "My Venmo name or username:",
      "Approximate payment date and time:",
      "Payment note I actually sent:",
      "",
      "Thanks!",
    ].join("\n"),
  });
  return `mailto:${PAYMENT_SUPPORT_EMAIL}?${query.toString()}`;
}
