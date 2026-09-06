import axios from "axios";
import type { Course, CoursesResponse } from "@/server/api/types.ts";

const REQUEST_TIMEOUT_MS = 15_000;

const headers = {
  Accept: "application/json",
  "Accept-Language": "en",
  Connection: "keep-alive",
  Referer: "https://classes.usc.edu/term/20261/catalogue/school/DRNS/program/ALI",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  "X-CSRF": "1",
  "sec-ch-ua": '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  Cookie:
    "WWTRBQJP=0297a45327-1bed-4fbvhA7tmVq0FYouNMXTFTdTKGVFaYzTPxk8oUX_uT47Wi1X0zsUwkN-lMydtplV503bs; _dd_s=rum=2&id=bc769e8c-ecbc-4367-bc46-08d5a660ac67&created=1760651429901&expire=1760652353037",
};

export const getCurrentAvailableCourses = async ({ semester }: { semester: string }) => {
  const response = await axios.get<CoursesResponse>("https://classes.usc.edu/api/Search/Autocomplete", {
    params: {
      termCode: semester,
    },
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return response.data;
};
export const getCourseInformation = async ({ courseCode, semester }: { courseCode: string; semester: string }) => {
  const response = await axios.get<Course>("https://classes.usc.edu/api/Courses/Course", {
    params: {
      termCode: semester,
      courseCode,
    },
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return response.data;
};
export const searchClasses = async ({ searchTerm, semester }: { searchTerm: string; semester: string }) => {
  const response = await axios.get<CoursesResponse>("https://classes.usc.edu/api/Search/Basic", {
    params: {
      termCode: semester,
      searchTerm,
    },
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return response.data;
};
