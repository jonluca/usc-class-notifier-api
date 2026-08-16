export const TimeSteps = {
  SECONDS: "seconds",
  MINUTES: "minutes",
  HOURS: "hours",
  DAYS: "days",
  WEEKS: "weeks",
  MONTHS: "months",
  YEARS: "years",
} as const;

const SECOND = 1;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY; // Approximate value
const YEAR = 365 * DAY;

export interface TimeOffset {
  value: number;
  timestep: (typeof TimeSteps)[keyof typeof TimeSteps];
}

export function getTimeOffset(pastDate: Date, isFutureDate: boolean): TimeOffset {
  const now = new Date();
  const delta = isFutureDate ? pastDate.getTime() - now.getTime() : now.getTime() - pastDate.getTime();
  const seconds = Math.floor(delta / 1000);

  let interval = seconds / YEAR;
  if (interval > 1) {
    return { value: Math.floor(interval), timestep: TimeSteps.YEARS };
  }

  interval = seconds / MONTH;
  if (interval > 1) {
    return { value: Math.floor(interval), timestep: TimeSteps.MONTHS };
  }

  interval = seconds / WEEK;
  if (interval > 1) {
    return { value: Math.floor(interval), timestep: TimeSteps.WEEKS };
  }

  interval = seconds / DAY;
  if (interval > 1) {
    return { value: Math.floor(interval), timestep: TimeSteps.DAYS };
  }

  interval = seconds / HOUR;
  if (interval > 1) {
    return { value: Math.floor(interval), timestep: TimeSteps.HOURS };
  }

  interval = seconds / MINUTE;
  if (interval > 1) {
    return { value: Math.floor(interval), timestep: TimeSteps.MINUTES };
  }

  return { value: Math.floor(seconds), timestep: TimeSteps.SECONDS };
}
