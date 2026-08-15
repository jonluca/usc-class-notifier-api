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

No generated files are checked into the source archive. WXT and Vite bundle the TypeScript/React entrypoints and their public npm dependencies. The production extension communicates only with `https://usc.jonlu.ca` when a user explicitly submits a class notification request. Email notifications are free; optional SMS notifications cost $1 per section per semester.

## Functional review

1. Visit a public USC classes page under `https://classes.usc.edu/term/`.
2. Open a course with instructor results. The extension adds a `PROF RATING` column with Rate My Professors links when matching rating data exists.
3. The extension adds notification controls to eligible section rows. Clicking one opens a form that clearly shows the selected class and requests an email address plus an optional phone number.
4. Visit `https://webreg.usc.edu/` while authenticated with USC. The extension adds schedule conflict and unit information and an Export to Calendar link.
5. Use the toolbar popup to enable or disable the extension, conflict highlighting, and unit totals.

The add-on stores only those three display preferences in extension local storage. A submitted notification request sends the entered email address, optional phone number, and the selected class's department, section, and semester to the service described above.
