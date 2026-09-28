# Dark mode handoff

Branch: `dark-mode`. Committed through `ddec9ad` ("minor fixes, restrictions
page") as of 2026-09-28.

Rebased onto upstream `jonluca/usc-class-notifier-api` `master` at `6c605c2`.
The only conflict was `SOURCE_CODE_REVIEW.md` - resolved by keeping
upstream's detailed `.ics` export steps (4-6) plus this branch's dark-mode
step and full page list (step 7) in the same file. Upstream's four commits
touched `coursesPage.ts` and `schedule.ts`, not any dark-mode file, so the
rebase didn't require re-deriving or re-verifying any CSS/guard logic - just
that one doc merge. Rebasing rewrote every commit hash on this branch (all
the hashes referenced elsewhere in this doc predate it), and the branch has
**not been pushed since** - the next push to `origin/dark-mode` needs
`--force-with-lease`, not a plain push, since the remote still has the
pre-rebase commits.

## Status

Implemented and verified live by the user: `/Calendar` (Kendo Scheduler,
including the Event edit dialog's `.k-window` chrome and the `.k-today`
column highlight), `/CourseBin` (course accordion), `/Departments`
(department list), `/Courses` (course list + pagination), `/Terms` (guard +
secondary nav bar under the masthead), and the footer's `.footer-links`
site-wide. Each page's fixes were driven by devtools matched-rules reports
the user ran and pasted back, then verified live after a production build.

Guard widened and verified live (page ground/chrome only — most of these
pages have no page-specific CSS of their own, they just inherit the
Bootstrap-chrome/course-accordion/section-table rules already written for
Calendar/CourseBin/Departments/Courses):

- `/TuitionRefundInsurance` — guard only, no dedicated CSS needed.
- `/Checkout` — guard, plus `.RegAdDrpTitl` (register/drop banner) and
  `.accordion-content-area` left-border fix (see Site facts below).
- `/ClearedSections` — guard only, verified in its empty state; populated
  state not yet screenshotted.
- `/RegisteredCourses` — guard only, populated course list verified.
- `/RegistrationAppointment` — guard, plus `.permit-background` card-surface
  fix (see Site facts below).
- `/Terms` — guard, plus `nav.navbar > .container-fluid`/`nav.navbar` border
  fix for the secondary "Welcome, ... Logout" bar (see Site facts below).

Beyond WebReg's own pages, dark mode also now covers two pieces of our own
UI: the extension popup (`src/popup/index.tsx`, follows the same
`darkModeStorage` setting independently of any WebReg page) and the
`NotificationModal` ("Notify Me" dialog, `src/extension/notification.tsx`,
reads `darkModeStorage`/`extensionEnabledStorage` directly rather than the
`html.usc-helper-dark` DOM class since it's a React component with its own
lifecycle).

Not started: none currently queued. Ask the user for the next page and a
matched-rules report before writing any new selector.

## Files

- `src/extension/darkMode.ts` — the page guard. `isDarkModeSupportedPage(href)`
  lowercases the pathname and checks `startsWith` against `/calendar`,
  `/coursebin`, `/departments`, `/courses`, `/tuitionrefundinsurance`,
  `/checkout`, `/clearedsections`, `/registeredcourses`,
  `/registrationappointment`, and `/terms` — the single list to extend for a
  new page. `shouldEnableDarkMode(options, href)` additionally requires the
  extension enabled + the setting on; reused directly by
  `src/extension/notification.tsx` (see Status above) rather than duplicating
  the enabled+page-allowlist logic there. `setDarkModeActive(enabled)` toggles
  `html.usc-helper-dark`, reading the _current DOM class_ (not a
  module-level flag) to decide whether a toggle is a no-op, since this module
  is bundled separately into both content scripts that call it (the main
  content script and `darkMode.content.ts`) and a cached flag would be two
  independent copies that could silently diverge from each other; it also
  mirrors to `localStorage` for synchronous first-paint reads.
  `readDarkModeMirror()` reads that mirror back.
- `src/entrypoints/darkMode.content.ts` — second WXT content script, matches
  `*://webreg.usc.edu/*` only (all paths, no page filtering, and notably
  _not_ `classes.usc.edu` - see the NotificationModal note under Status), so
  widening the guard above is the only change needed to support a new WebReg
  page. Its `document_start` mirror-apply only mirrors the combined
  `darkModeStorage` result, not `extensionEnabledStorage` separately - if the
  user disables the whole extension while zero WebReg tabs are open, the next
  cold `/Calendar`-type load can flash dark mode for one frame before the
  async check (which does check both) corrects it a few ms later. Reviewed
  and accepted: the mirror only exists to dodge `browser.storage`'s async
  gap, so closing this fully would mean giving up the FOUC-avoidance
  optimization entirely for a narrow, self-correcting edge case.
- `src/styles/webregDark.css` (~750 lines) — the entire theme, one file, all
  rules scoped `html.usc-helper-dark ...` inside `@media screen`. Sections
  top-to-bottom: palette → WebReg page ground → Bootstrap 3 chrome → masthead
  - nav (including the /Terms secondary nav bar and footer links) → alerts →
    buttons/inputs → myCourseBin → myDepartments → myCourses → Checkout →
    Registration Appointment → Kendo Scheduler (including the Event edit
    dialog's `.k-window` chrome) → event/legend colors → our own injected UI.
- `src/extension/style.ts` — pre-existing light-mode overlay rules
  (`.overlaps`, `.closed`, `.closedAndOverlaps`, `.crsTitlCustom`) written as
  `var(--ush-x, <original literal>)` so they auto-adapt in dark mode and still
  resolve correctly for print/light mode.
- `src/extension/notification.tsx` — the "Notify Me" modal (`NotificationModal`).
  Reads `darkModeStorage`/`extensionEnabledStorage` directly via
  `shouldEnableDarkMode` (see darkMode.ts above) rather than depending on the
  `html.usc-helper-dark` DOM class, since it's a React component with its own
  lifecycle and also mounts on `classes.usc.edu`, which has no dark-mode
  infrastructure at all.
- `src/extension/darkPalette.ts` — shared Tailwind class-token constants
  (`bg-[#0d0d0d]`, etc.) so `notification.tsx` and `src/popup/index.tsx` don't
  each hardcode the same hex values independently. Each entry must stay a
  complete, literal string - Tailwind finds classes by scanning source text,
  not by evaluating JS, so a class assembled from pieces at a call site
  (e.g. appending `!important` to an imported constant) is invisible to it
  and silently never generated. A short-lived version of this file that got
  it wrong was caught by rebuilding and grepping the compiled CSS for the
  exact selector - the way to verify any change here.
- `src/extension/extension.ts`, `src/extension/utils.ts` (`Options.darkMode`),
  `src/extension/storage.ts`, `src/popup/index.tsx`, `src/contents/content.tsx`
  — plumbing: storage item, live toggle wiring, popup checkbox (now themed
  too, see Status above).
- `src/extension/darkMode.test.ts` — guard unit tests (`tsx --test`, no DOM).
- `SOURCE_CODE_REVIEW.md` — mentions four stored preferences (read by Mozilla
  add-on reviewers); its functional-review section names the actual page
  list dark mode covers, so update it alongside `darkMode.ts` if that list
  changes.

## Palette (`html.usc-helper-dark`)

Surfaces: `--ush-surface #0d0d0d`, `--ush-surface-raised #161616`,
`--ush-surface-sunken #0a0a0a`, `--ush-surface-hover #232323`,
`--ush-surface-alt #131313`. Lines: `--ush-border #2a2a2a`,
`--ush-border-strong #3d3d3d`. Type: `--ush-text #e8e8ec`,
`--ush-text-muted #9a9aa2`, `--ush-link #ff9a9a` (hover `#ffb8b8`). USC
identity (masthead/active tab only): `--ush-cardinal #8b0000`,
`--ush-cardinal-deep #3d0000`, `--ush-gold #ffc72c`, `--ush-gold-ink #241a00`.
Overlay vars consumed by `style.ts`: `--ush-overlap-bg`, `--ush-closed-bg`,
`--ush-closed-overlap-bg`.

## Site facts (with real selectors)

- `webregDark.css` is manifest-injected (`cssInjectionMode: "manifest"`), so
  it never appears in `document.styleSheets` from a devtools matched-rules
  script — any report will only ever show WebReg's own rules.
- Kendo event fills are inline per-event, keyed by exact rgb() match:
  `.k-event[style*="background-color: rgb(60, 167, 15)"]` (Registered),
  `.k-event.k-event-inverse[style*="background-color: rgb(255, 204, 0)"]`
  (Scheduled — also has Kendo's own `.k-event-inverse` forcing black text,
  flipped back to `--ush-text`), `.k-event[style*="background-color: rgb(255,
0, 0)"]` (Conflict).
- Zebra-stripe specificity traps recur: CourseBin's
  `.course-header:nth-child(4n+1)`, Departments'
  `.department-header:nth-child(4n+3)`, and Courses'
  `.section:nth-child(2n+1) .section-row` each needed an `html.usc-helper-dark
.foo` override with a matching or higher class count to win — plain
  `.foo { background: ... }` loses to these every time.
- The generic input rule excludes by `[type]`, not by class:
  `input:not([type="hidden"]):not([type="submit"]):not([type="button"])` —
  submit/button inputs (e.g. `.dept_srchGo`, `.lnkCrs`) are styled separately
  as buttons or links instead.
- `.pagination > .disabled > a`'s `border-color: rgb(221, 221, 221)` was
  deliberately left unmapped to `--ush-border` — the active/normal pagination
  links carry the same border-color unmodified and read fine on the dark
  background, so overriding it only on the disabled item made its outline the
  only one that went missing.
- `/TuitionRefundInsurance`, `/Checkout`, and `/RegistrationAppointment` have
  no `.container.inner-container` — content sits directly under `#sb-site >
.row.main-container > .col-* > .content-wrapper-*` (`-regconfirm`,
  `-regconfirm`, `-permit` respectively). No wrapper-specific rule was ever
  needed for the page ground: it comes for free from the unconditional
  `html.usc-helper-dark` / `body` / `.page-background` / `#sb-site` rules,
  which aren't scoped to any wrapper class. `/ClearedSections` and
  `/RegisteredCourses` _do_ have `.inner-container` and share
  `.content-wrapper-clearedList`.
- `.RegAdDrpTitl` (Checkout's "You are about to REGISTER/DROP for the
  following sections:" banner) is a single class shared by both the REGISTER
  and DROP variants (confirmed: the report keys the WebReg rule off the class
  alone, not the text), so one rule covers both — beats `site_styles.css:
.RegAdDrpTitl { background-color: rgb(102, 102, 102); color: rgb(255, 255,
255); padding: 3px }`.
- `.accordion-content-area` needed both `border-bottom-color` and
  `border-left-color` mapped to `--ush-border` — `site_styles.css` sets both
  as separate declarations in the same rule (`border-bottom: 1px solid
rgb(242, 241, 241); border-left: 1px solid rgb(242, 241, 241)`); no
  `border-right`/`border-top` declared, so none added.
- `.permit-background` (RegistrationAppointment's date card) is
  `site_styles.css: .permit-background { background-color: rgb(241, 241,
  241); border: thin solid rgb(220, 220, 220); border-color: rgb(220, 220,

220. }`— background/border only, no`color`on the element or its child
 `div`/`span`(report showed "no matching page rules" for those), so the
  date text already inherits`--ush-text`once the card background goes dark;
  no separate text-color override was needed.`radius=0px`in the computed
  report, so no`border-radius` was added.

## Content-script Tailwind vs. WebReg CSS (cascade layers)

The React UI the content script renders (`src/contents/content.tsx`, mounted
`anchor: "body"` / `position: "inline"` — integrated into the page, not a
shadow root) shares the live DOM with WebReg's own stylesheets. Its Tailwind
classes come from `src/styles/globals.css` (`@import "tailwindcss"`), and
Tailwind v4's compiled output wraps everything in native CSS `@layer`
blocks — `.output/*/content-scripts/content.css` opens with `@layer
properties, theme, base, components, utilities`, and every utility class
(`.bg-gray-100`, `.bg-[#8b0000]`, etc.) lives inside `@layer utilities`.
WebReg's own `vendor_styles.css`/`site_styles.css` are legacy, **unlayered**
CSS.

Per the CSS cascade, for normal (non-`!important`) declarations, **any
unlayered author rule beats any layered author rule outright, before
specificity is even consulted.** So a Tailwind utility class can be present
in the compiled sheet, correctly matching the element by class, and still
lose completely to a WebReg rule that looks numerically less specific —
confirmed live on `/Courses`: `.bg-gray-100 { background-color:
var(--color-gray-100) }` (layered) lost outright to `vendor_styles.css:
button { background-color: rgb(0, 140, 186); color: rgb(255, 255, 255);
border: 0px solid rgb(0, 112, 149) }` (unlayered, spec `0,0,1`) on the
Submit button in `src/extension/notification.tsx`, even though `.bg-gray-100`
is a class selector and should have won by specificity alone. It had never
actually rendered gray in production, in light mode or dark - discovered
while building the modal's dark-mode support, unrelated to dark mode itself.

**Confirmed exposed** (WebReg sets `color`/`background-color`/`border` on
the bare tag globally): `button`, `input[type="email"]` (and presumably
other typed inputs, per the generic input rule noted under Site facts), `a`.
**Not exposed**: `div`, `section` - WebReg has no generic rule for those, so
a plain Tailwind background/text class on a wrapper `<div>` works fine.

Caveat: this isn't only a WebReg-stylesheet problem. `webregDark.css` itself
is also plain unlayered CSS (see the closing note below), so its own
blanket tag-level rules (e.g. `html.usc-helper-dark p, span, label, h1-h6,
td, th { color: var(--ush-text) }`) will equally defeat a _different_ color
a Tailwind-layered dark-mode class tries to put on the same tag - e.g. a MUI
`Typography` renders a `<p>`, so giving it `--ush-text-muted` instead of the
blanket `--ush-text` needs the same fix below, only once dark mode is on.

**Fix:** mark the Tailwind utility `!important` (Tailwind v4's `!` suffix,
e.g. `bg-[#8b0000]!`) or use an inline `style` prop. A plain utility class is
never sufficient for an element on an exposed tag, no matter how specific
its selector looks in source.

Separately: centralizing a few of these tokens into `src/extension/darkPalette.ts`
(see Files above) is safe - Tailwind's scanner looks for literal candidate
strings across _all_ project source files, not just the file where a
className is written, so a complete token sitting in a small constants
module is found just as reliably as one inline in JSX. What's _not_ safe is
building the string dynamically at the call site (`` `bg-[${hex}]` ``, or
appending `!` to an imported constant) - that produces a string Tailwind's
static scanner never sees as a whole, so the class is silently never
generated. Every distinct token, `!important` variants included, needs its
own complete literal entry.

**How to recognize the symptom:** a Tailwind class that is present in the
compiled sheet and correctly `.matches()` the element, but **never appears
at all** in a devtools matched-rules report for that element - that's the
layered/unlayered tier loss, not a specificity problem. A genuine
specificity loss still shows the losing rule _in_ the matched list, just
outranked by something with a higher score; a rule that's entirely absent
despite matching by class is the tell.

**Scope:** only the content-script React UI (`src/contents/*`,
`src/extension/notification.tsx`, `src/components/VenmoPaymentPanel.tsx`,
anything else rendered into the WebReg page). The popup (`src/popup/*`) and
the separate web dashboard (`src/pages/*`) are exempt - their own documents,
no WebReg CSS present at all.

**Audit finding, not yet fixed:** `src/components/VenmoPaymentPanel.tsx`
(rendered inside this same NotificationModal when `data.showVenmoInfo` is
true) has the identical exposure on one `<button>` (`bg-violet-100
border-violet-300 text-violet-900`, the "Copy note" button) and two `<a>`
tags (`bg-[#008CFF] text-white`, the Venmo pay link; `text-violet-800`, the
"Recover your payment" link) - all plain, non-`!` Tailwind classes, all
currently rendering in WebReg's blue instead of their intended colors, in
production today. Deferred: out of scope for the notification-modal
light/dark commits (which touch only `notification.tsx`), and it would also
need its own dark-mode design decision, not just a mechanical `!` fix.

webregDark.css remains hand-written plain CSS, never passed through
Tailwind, so it is **not** layer-wrapped and doesn't inherit this hazard -
its existing specificity-based reasoning (documented throughout this file)
is unaffected and doesn't need re-deriving.

## Open / deferred items

- Prof. Rating column misalignment on `/Courses` — pre-existing bug, explicitly
  out of scope, not touched.
- The `/Courses` conflict highlighter (`src/extension/*` — sets inline
  `background-color: rgba(255, 134, 47, 0.37)` on `.section`/`.section-row`,
  storing the original in `data-usc-helper-conflict-original-style`) currently
  wins over `webregDark.css` via inline style, same as WebReg's own inline
  styles. The user raised writing it as a CSS variable (like
  `--ush-overlap-bg` in `style.ts`) instead of a literal inline value, so
  `webregDark.css` wouldn't need `!important` to beat it — proposed, not yet
  decided or implemented.
- `/ClearedSections` populated state (with actual cleared-section data,
  reusing Courses-style course-header/section-table markup) hasn't been
  screenshotted — only the empty state has. Don't assume it's covered without
  checking; it should be, by the same shared-class rules RegisteredCourses
  uses, but hasn't been confirmed live.
- `/ClearedSections`'s `#result2` inline yellow banner (`background-color:
rgb(255, 216, 0); color: rgb(153, 0, 0)`, `display: none` by default) was
  noted but never triggered/verified — if it ever shows, it may need the same
  inline-override treatment as `#dialog_aud` etc. in myCourseBin.
- `/RegisteredCourses`'s red inline `Closed` span (`style="color: #ff0000"`)
  was flagged for checking but no report/screenshot confirming it reads fine
  (or needs its own rule) has come back yet.
- The Bootstrap chrome block (`.container`/`.panel`/`.well`/generic
  `a`/`h1-h6`/`label`/`p`/`span`/`td`/`th`/`.text-muted`/`small`/`hr`, roughly
  lines 121-159), the masthead `.navbar`/`#header` gradient block, and the
  whole Kendo Scheduler chrome block (`.k-widget` through `.k-current-time`,
  roughly lines 552-624) predate the "cite the exact WebReg rule per
  selector" discipline (they're from the very first commit, before later
  rounds established it) and don't have it. Not retrofitted here - doing so
  without a live devtools report would be exactly the guessing the working
  method exists to prevent. If any of these are touched again, get a report
  for them at that point rather than assuming the existing values are
  correct.

## Working method

Never guess a selector, color, or specificity outcome — every rule must cite
the exact WebReg rule (file + selector + value) it overrides, sourced from a
devtools matched-rules report the user runs and pastes back; ask again if a
report is referenced but missing. Targeted selectors only, no `*`/bare
`div`/broad `[class*=]` sweeps. `!important` only where evidence shows an
inline style or a WebReg `!important` being beaten, stated per rule. Keep
diffs to exactly what's asked; respect "out of scope" lists literally; flag
adjacent issues rather than silently fixing them. Guard-widening rounds are
kept strictly separate from CSS rounds (widen the guard with no new CSS
first, verify live, then fix specific elements in a follow-up round).

After every change: `corepack pnpm typecheck`, `lint`, `format`, `test`, then
`NODE_ENV=production corepack pnpm build:chrome` (plain `pnpm` isn't on PATH
here — prefix with `corepack`). The user reloads the unpacked extension at
`chrome://extensions` (`.output/chrome-mv3`) and reports back with
screenshots/reports; don't claim a fix works without that loop.
`pnpm dev:extension` flashes more than production and must not be used to
judge FOUC. `claude-in-chrome` has been declined for this project — rely on
the user's own devtools reports.
