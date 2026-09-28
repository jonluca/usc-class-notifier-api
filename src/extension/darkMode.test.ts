import assert from "node:assert/strict";
import test from "node:test";
import { isDarkModeSupportedPage, shouldEnableDarkMode } from "@/extension/darkMode";

test("isDarkModeSupportedPage matches Calendar, CourseBin, Departments, Courses, TuitionRefundInsurance, Checkout, ClearedSections, RegisteredCourses, RegistrationAppointment, Terms, Restrictions, and Acknowledgement paths, case-insensitively", () => {
  assert.equal(isDarkModeSupportedPage("https://webreg.usc.edu/Calendar"), true);
  assert.equal(isDarkModeSupportedPage("https://webreg.usc.edu/calendar/details"), true);
  assert.equal(isDarkModeSupportedPage("https://webreg.usc.edu/CourseBin"), true);
  assert.equal(isDarkModeSupportedPage("https://webreg.usc.edu/coursebin/details"), true);
  assert.equal(isDarkModeSupportedPage("https://webreg.usc.edu/Departments"), true);
  assert.equal(isDarkModeSupportedPage("https://webreg.usc.edu/departments/details"), true);
  assert.equal(isDarkModeSupportedPage("https://webreg.usc.edu/Courses"), true);
  assert.equal(isDarkModeSupportedPage("https://webreg.usc.edu/courses?pageNumber=2&Program=csci"), true);
  assert.equal(isDarkModeSupportedPage("https://webreg.usc.edu/TuitionRefundInsurance"), true);
  assert.equal(isDarkModeSupportedPage("https://webreg.usc.edu/tuitionrefundinsurance"), true);
  assert.equal(isDarkModeSupportedPage("https://webreg.usc.edu/Checkout"), true);
  assert.equal(isDarkModeSupportedPage("https://webreg.usc.edu/checkout/CheckoutResponse"), true);
  assert.equal(isDarkModeSupportedPage("https://webreg.usc.edu/ClearedSections"), true);
  assert.equal(isDarkModeSupportedPage("https://webreg.usc.edu/clearedsections"), true);
  assert.equal(isDarkModeSupportedPage("https://webreg.usc.edu/RegisteredCourses"), true);
  assert.equal(isDarkModeSupportedPage("https://webreg.usc.edu/registeredcourses"), true);
  assert.equal(isDarkModeSupportedPage("https://webreg.usc.edu/RegistrationAppointment"), true);
  assert.equal(isDarkModeSupportedPage("https://webreg.usc.edu/registrationappointment"), true);
  assert.equal(isDarkModeSupportedPage("https://webreg.usc.edu/Terms"), true);
  assert.equal(isDarkModeSupportedPage("https://webreg.usc.edu/terms"), true);
  assert.equal(isDarkModeSupportedPage("https://webreg.usc.edu/Terms?term=20263&handler=TermSelect"), true);
  assert.equal(isDarkModeSupportedPage("https://webreg.usc.edu/Restrictions"), true);
  assert.equal(isDarkModeSupportedPage("https://webreg.usc.edu/restrictions"), true);
  assert.equal(isDarkModeSupportedPage("https://webreg.usc.edu/Acknowledgement"), true);
  assert.equal(isDarkModeSupportedPage("https://webreg.usc.edu/acknowledgement"), true);
});

test("isDarkModeSupportedPage rejects other WebReg pages and invalid URLs", () => {
  assert.equal(isDarkModeSupportedPage("https://webreg.usc.edu/myInfo"), false);
  assert.equal(isDarkModeSupportedPage("not a url"), false);
});

test("shouldEnableDarkMode requires the extension enabled, the setting on, and a supported page", () => {
  const calendarUrl = "https://webreg.usc.edu/Calendar";
  const courseBinUrl = "https://webreg.usc.edu/CourseBin";
  const departmentsUrl = "https://webreg.usc.edu/Departments";
  const coursesUrl = "https://webreg.usc.edu/Courses";
  const tuitionRefundInsuranceUrl = "https://webreg.usc.edu/TuitionRefundInsurance";
  const checkoutUrl = "https://webreg.usc.edu/Checkout";
  const clearedSectionsUrl = "https://webreg.usc.edu/ClearedSections";
  const registeredCoursesUrl = "https://webreg.usc.edu/RegisteredCourses";
  const registrationAppointmentUrl = "https://webreg.usc.edu/RegistrationAppointment";
  const termsUrl = "https://webreg.usc.edu/Terms";
  const restrictionsUrl = "https://webreg.usc.edu/Restrictions";
  const acknowledgementUrl = "https://webreg.usc.edu/Acknowledgement";
  assert.equal(shouldEnableDarkMode({ enabled: true, darkMode: true }, calendarUrl), true);
  assert.equal(shouldEnableDarkMode({ enabled: true, darkMode: true }, courseBinUrl), true);
  assert.equal(shouldEnableDarkMode({ enabled: true, darkMode: true }, departmentsUrl), true);
  assert.equal(shouldEnableDarkMode({ enabled: true, darkMode: true }, coursesUrl), true);
  assert.equal(shouldEnableDarkMode({ enabled: true, darkMode: true }, tuitionRefundInsuranceUrl), true);
  assert.equal(shouldEnableDarkMode({ enabled: true, darkMode: true }, checkoutUrl), true);
  assert.equal(shouldEnableDarkMode({ enabled: true, darkMode: true }, clearedSectionsUrl), true);
  assert.equal(shouldEnableDarkMode({ enabled: true, darkMode: true }, registeredCoursesUrl), true);
  assert.equal(shouldEnableDarkMode({ enabled: true, darkMode: true }, registrationAppointmentUrl), true);
  assert.equal(shouldEnableDarkMode({ enabled: true, darkMode: true }, termsUrl), true);
  assert.equal(shouldEnableDarkMode({ enabled: true, darkMode: true }, restrictionsUrl), true);
  assert.equal(shouldEnableDarkMode({ enabled: true, darkMode: true }, acknowledgementUrl), true);
  assert.equal(shouldEnableDarkMode({ enabled: false, darkMode: true }, courseBinUrl), false);
  assert.equal(shouldEnableDarkMode({ enabled: true, darkMode: false }, courseBinUrl), false);
  assert.equal(shouldEnableDarkMode({ enabled: true, darkMode: true }, "https://webreg.usc.edu/myInfo"), false);
});
