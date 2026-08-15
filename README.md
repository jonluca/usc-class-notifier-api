# USC Schedule Helper

USC Schedule Helper improves USC class search and registration with professor ratings, schedule insights, and class availability notifications. This repository contains the Next.js notification service and the cross-browser WXT extension.

The Chrome extension is available from the [Chrome Web Store](https://chrome.google.com/webstore/detail/usc-schedule-helper/gchplemiinhmilinflepfpmjhmbfnlhk).
Its privacy policy is available both [in this repository](./PRIVACY.md) and on the live service at [usc.jonlu.ca/privacy](https://usc.jonlu.ca/privacy).

## Extension builds

```sh
# Chrome
pnpm run package:extension

# Firefox (Manifest V3)
pnpm run package:firefox
```

Firefox packages are written to `.output/` as an extension ZIP and a source ZIP for Mozilla review. See `SOURCE_CODE_REVIEW.md` for reproducible build instructions.
