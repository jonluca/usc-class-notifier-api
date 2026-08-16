export const MONTHS = {
  January: 1,
  February: 2,
  March: 3,
  April: 4,
  May: 5,
  June: 6,
  July: 7,
  August: 8,
  September: 9,
  October: 10,
  November: 11,
  December: 12,
};

export const SEMESTER_CODE_PATTERN = /^\d{4}[123]$/;

const TERM_URL_PATTERN = /(?:^|\/)term\/(\d{4}[123])(?:\/|$|[?#])/i;
const TERM_LABEL_PATTERN = /^(spring|summer|fall)\s+(\d{4})(?:\s+classes)?$/i;
const TERM_SUFFIX = {
  spring: "1",
  summer: "2",
  fall: "3",
} as const;

function getTermSuffix(term: string): (typeof TERM_SUFFIX)[keyof typeof TERM_SUFFIX] | undefined {
  switch (term.toLowerCase()) {
    case "spring":
      return TERM_SUFFIX.spring;
    case "summer":
      return TERM_SUFFIX.summer;
    case "fall":
      return TERM_SUFFIX.fall;
    default:
      return undefined;
  }
}

/**
 * Parses USC term codes from either a raw five-digit code, a classes.usc.edu
 * term URL/path, or the term labels USC renders in its active tab.
 */
export function parseSemesterTerm(value: string | null | undefined): string | undefined {
  const normalizedValue = value?.trim().replace(/\s+/g, " ");
  if (!normalizedValue) {
    return undefined;
  }

  if (SEMESTER_CODE_PATTERN.test(normalizedValue)) {
    return normalizedValue;
  }

  const urlMatch = normalizedValue.match(TERM_URL_PATTERN);
  if (urlMatch?.[1]) {
    return urlMatch[1];
  }

  const labelMatch = normalizedValue.match(TERM_LABEL_PATTERN);
  if (!labelMatch?.[1] || !labelMatch[2]) {
    return undefined;
  }

  const suffix = getTermSuffix(labelMatch[1]);
  return suffix ? `${labelMatch[2]}${suffix}` : undefined;
}

const SPRING_REGISTRATION_RANGE_NEXT_YEAR = [MONTHS.October, MONTHS.November, MONTHS.December];
const SPRING_REGISTRATION_RANGE_THIS_YEAR = [MONTHS.January, MONTHS.February];
export const SPRING_REGISTRATION_RANGE = [
  ...SPRING_REGISTRATION_RANGE_NEXT_YEAR,
  ...SPRING_REGISTRATION_RANGE_THIS_YEAR,
];
export const SUMMER_REGISTRATION_RANGE = [
  MONTHS.February,
  MONTHS.March,
  MONTHS.April,
  MONTHS.May,
  MONTHS.June,
  MONTHS.July,
];
export const FALL_REGISTRATION_RANGE = [
  MONTHS.March,
  MONTHS.April,
  MONTHS.May,
  MONTHS.June,
  MONTHS.July,
  MONTHS.August,
  MONTHS.September,
];

export function getValidSemesters() {
  // we want to get this years (1, 2, 3) and next years (1)
  const date = new Date();
  const year = date.getFullYear();
  const month = date.getMonth() + 1;

  const semesters: string[] = [];
  if (SPRING_REGISTRATION_RANGE_NEXT_YEAR.includes(month)) {
    semesters.push(`${year + 1}1`);
  }
  if (SPRING_REGISTRATION_RANGE_THIS_YEAR.includes(month)) {
    semesters.push(`${year}1`);
  }
  if (SUMMER_REGISTRATION_RANGE.includes(month)) {
    semesters.push(`${year}2`);
  }
  if (FALL_REGISTRATION_RANGE.includes(month)) {
    semesters.push(`${year}3`);
  }
  return semesters;
}

export function getCurrentSemester() {
  const date = new Date();
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  // semesters work like 20213, 20211, etc
  // we only want to really watch for spring and fall, since summer isnt supported
  if (SPRING_REGISTRATION_RANGE_NEXT_YEAR.includes(month)) {
    return `${year + 1}1`;
  }

  if (SPRING_REGISTRATION_RANGE_THIS_YEAR.includes(month)) {
    return `${year}1`;
  }
  if (FALL_REGISTRATION_RANGE.includes(month)) {
    return `${year}3`;
  }
  console.error(`Invalid month ${month}`);
  // never assume that it's summer, just return fall
  return `${year}3`;
}
