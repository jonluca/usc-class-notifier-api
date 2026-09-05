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

To create the same submission ZIP and source ZIP, run:

```sh
pnpm run package:firefox
```

No generated files are checked into the source archive. WXT and Vite bundle the TypeScript/React entrypoints and their public npm dependencies. Notification requests are sent to `https://usc.jonlu.ca` only when a user explicitly submits the notification form. Email notifications are free; optional SMS notifications cost $1 per section per semester.

Calendar export reads the registered schedule from the user's authenticated Web Registration session and generates the `.ics` file locally. It looks up course and session dates through public `https://classes.usc.edu/api/` endpoints and term dates and holidays through `https://www.usc.edu/academic-calendar/`. These public requests contain course, term, or session identifiers and use `credentials: "omit"`; they do not include USC sign-in credentials or upload the full registered schedule. The manifest's host permissions are exactly `https://classes.usc.edu/*` and `https://www.usc.edu/*`, in addition to the existing `storage` permission. If the extension cannot validate the schedule or calendar data, it opens USC's official exporter at `https://my.usc.edu/ical/?term=...` instead of downloading an incomplete calendar.

## Functional review

1. Visit a public USC classes page under `https://classes.usc.edu/term/`.
2. Open a course with instructor results. The extension adds a `PROF RATING` column with Rate My Professors links when matching rating data exists.
3. The extension adds notification controls to eligible section rows. Clicking one opens a form that clearly shows the selected class and requests an email address plus an optional phone number.
4. Visit the Calendar page on `https://webreg.usc.edu/` while authenticated with USC. The extension adds schedule conflict and unit information and an **Export as .ics** button next to **Export to PDF**.
5. With registered classes that have meeting times, click **Export as .ics**. Open the downloaded calendar and verify meeting times and locations, session-specific start and end dates, and exclusion of university holidays and session breaks. Explicit TBA classes are skipped and counted in the completion message. Where available, repeat with a short session and a different semester or year.
6. To exercise the fallback, block a public USC metadata request in the extension background's developer tools, then repeat the export. The extension should open USC's official calendar exporter for the selected term without downloading a partial `.ics` file.
7. Use the toolbar popup to enable or disable the extension, conflict highlighting, and unit totals.

The add-on stores only those three display preferences in extension local storage. A submitted notification request sends the entered email address, optional phone number, and the selected class's department, section, and semester to the service described above.
