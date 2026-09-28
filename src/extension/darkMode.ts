// Dark mode for webreg.usc.edu/Calendar, /CourseBin, /Departments, /Courses,
// /TuitionRefundInsurance, /Checkout, /ClearedSections, /RegisteredCourses, /RegistrationAppointment,
// /Terms, /Restrictions, and /Acknowledgement. Themes the page chrome (masthead, tabs, buttons, forms) via
// src/styles/webregDark.css, plus the Kendo Scheduler grid on Calendar and the course
// accordion/section table shared by CourseBin, Courses, Checkout, ClearedSections, and
// RegisteredCourses. Event and legend item colors on Calendar are left mostly as WebReg sets them
// (see webregDark.css for the specific exceptions).

export const DARK_MODE_CLASS = "usc-helper-dark";
const DARK_MODE_MIRROR_KEY = "usc-helper-dark-mode";

export function isDarkModeSupportedPage(href: string = window.location.href): boolean {
  try {
    const pathname = new URL(href).pathname.toLowerCase();
    return (
      pathname.startsWith("/calendar") ||
      pathname.startsWith("/coursebin") ||
      pathname.startsWith("/departments") ||
      pathname.startsWith("/courses") ||
      pathname.startsWith("/tuitionrefundinsurance") ||
      pathname.startsWith("/checkout") ||
      pathname.startsWith("/clearedsections") ||
      pathname.startsWith("/registeredcourses") ||
      pathname.startsWith("/registrationappointment") ||
      pathname.startsWith("/terms") ||
      // Unconfirmed: guessed from body.restrictions-page following the same
      // capitalized-body-class-minus-"-page" convention every other page here has matched so far -
      // verify the actual URL bar path once the page is reproducible and correct if wrong.
      pathname.startsWith("/restrictions") ||
      // Confirmed from the restrictions page's own "Continue" link (href="/Acknowledgement").
      pathname.startsWith("/acknowledgement")
    );
  } catch {
    return false;
  }
}

export function shouldEnableDarkMode(options: { enabled: boolean; darkMode: boolean }, href?: string): boolean {
  return options.enabled && options.darkMode && isDarkModeSupportedPage(href);
}

export function setDarkModeActive(enabled: boolean) {
  // Read the DOM directly rather than caching "active" in a module-level variable: this module is
  // bundled separately into both content scripts that call this function (the main content script
  // and darkMode.content.ts), so a cached flag would be two independent copies that can silently
  // diverge from each other and from the real DOM state. classList is the one thing both bundles
  // actually share.
  if (document.documentElement.classList.contains(DARK_MODE_CLASS) === enabled) {
    return;
  }
  document.documentElement.classList.toggle(DARK_MODE_CLASS, enabled);
  try {
    localStorage.setItem(DARK_MODE_MIRROR_KEY, enabled ? "1" : "0");
  } catch {
    // localStorage can throw under strict cookie/site-data settings; the mirror is only a
    // first-paint optimization, so failing silently is safe.
  }
}

/**
 * Reads a synchronous localStorage mirror of the dark-mode setting so a document_start content
 * script can apply the class before first paint, without waiting on the async storage API. Must
 * be reconciled with the authoritative value once it loads (see darkMode.content.ts).
 */
export function readDarkModeMirror(): boolean {
  try {
    return localStorage.getItem(DARK_MODE_MIRROR_KEY) === "1";
  } catch {
    return false;
  }
}
