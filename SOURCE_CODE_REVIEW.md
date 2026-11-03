# Firefox source code review

The submitted Firefox extension is built from this source archive with WXT. It does not require any API keys, database credentials, or `.env` files.

## Requirements

- Node.js 24 LTS
- Corepack
- Network access to the public npm registry

## Reproduce the submitted extension

From the root of the extracted source archive, run:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm run build:firefox
```

The unpacked extension is written to `.output/firefox-mv3/`.

Tailwind class discovery is restricted to `src`, excluding test files and captured HTML fixtures, so the source archive and repository checkout generate the same extension styles.

To create the same submission ZIP and source ZIP, run:

```sh
pnpm run package:firefox
```

Compiled extension bundles and generated Prisma clients are not included in the source archive. Installation runs WXT preparation and generates the PostgreSQL and D1 clients from the included schemas and configuration files; it does not connect to a database. WXT and Vite bundle the TypeScript/React entrypoints and their public npm dependencies. Notification requests are sent to `https://usc.jonlu.ca` only when a user explicitly submits the notification form. Email notifications are free; optional SMS notifications cost $1 per section per semester.

Calendar export reads the registered schedule from the user's authenticated Web Registration session and generates the `.ics` file locally. It looks up course and session dates through public `https://classes.usc.edu/api/` endpoints and term dates and holidays through `https://www.usc.edu/academic-calendar/`. These public requests contain course, term, or session identifiers and use `credentials: "omit"`; they do not include USC sign-in credentials or upload the full registered schedule. The manifest's required host permissions are `https://classes.usc.edu/*` and `https://www.usc.edu/*`, in addition to the existing `storage` permission. If the extension cannot validate the schedule or calendar data, it opens USC's official exporter at `https://my.usc.edu/ical/?term=...` instead of downloading an incomplete calendar.

Final Exams reads registered and scheduled courses from the authenticated CourseBin and resolves tentative exam times locally. It checks that the fetched CourseBin belongs to the term shown in the current tab before using its sections. The optional host permission `https://arr.usc.edu/*` is requested only when the user chooses **Allow live updates** and approves it in a separate extension page. With permission, the background fetches the public `https://arr.usc.edu/final-exam-schedule/` page with `credentials: "omit"`; the request contains no personal schedule or course identifiers. Both calendar metadata and final-exam messages are accepted only from `https://webreg.usc.edu`.

Parsed public exam data is cached locally by term with its fetch timestamp. It is considered fresh for 24 hours, but older entries remain available if a refresh fails. Without usable live or cached data, the extension uses `src/extension/finalExamsFallback.ts`, generated from the included registrar HTML fixture by `tools/generateFinalExamsFallback.ts`. This public cache does not contain the user's registered or scheduled courses. Final exams are view-only and are not added to calendar exports.

## Functional review

1. Visit a public USC classes page under `https://classes.usc.edu/term/`.
2. Open a course with instructor results. The extension adds a `PROF RATING` column with Rate My Professors links when matching rating data exists.
3. The extension adds notification controls to eligible section rows. Clicking one opens a form that clearly shows the selected class and requests an email address plus an optional phone number.
4. Visit the Calendar page on `https://webreg.usc.edu/` while authenticated with USC. The extension adds schedule conflict and unit information and an **Export as .ics** button next to **Export to PDF**.
5. With registered classes that have meeting times, click **Export as .ics**. Open the downloaded calendar and verify meeting times and locations, session-specific start and end dates, and exclusion of university holidays and session breaks. Explicit TBA classes are skipped and counted in the completion message. Where available, repeat with a short session and a different semester or year.
6. To exercise the fallback, block a public USC metadata request in the extension background's developer tools, then repeat the export. The extension should open USC's official calendar exporter for the selected term without downloading a partial `.ics` file.
7. Visit CourseBin and click **Final Exams** next to **Expand All** and **Collapse All**. Verify registered and scheduled courses appear with tentative dates or an explanation when a time cannot be determined. Before granting registrar access, the modal uses bundled or previously cached data.
8. Click **Allow live updates**, then **Allow arr.usc.edu** in the extension page. Granting access reloads the modal with live registrar data when available. Declining permission leaves the bundled or cached schedule available. With the permission granted, block the registrar request to check the fallback after the cache is stale; cached data is considered fresh for 24 hours.
9. To check term validation, open WebReg in two tabs, select different terms, then open Final Exams in the older tab. If its fetched CourseBin belongs to the other term, the modal must ask the user to reload and select the intended term instead of displaying exam dates.
10. Use the toolbar popup to enable or disable the extension, conflict highlighting, unit totals, and dark mode for WebReg's registration pages (myCalendar, myCourseBin, Departments, Courses, Tuition Refund Insurance, Checkout, Cleared Sections, Registered Courses, Registration Appointment, and Terms).

The add-on stores those four display preferences, the public exam cache and its fetch timestamps, and the most recent live-update permission grant timestamp in extension local storage. Cache entries are not automatically deleted after 24 hours; stored data remains until replaced, cleared, or the extension is removed. A submitted notification request sends the entered email address, optional phone number, and the selected class's department, section, and semester to the service described above.
