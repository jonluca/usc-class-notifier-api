import "@/styles/webregDark.css";
import { isDarkModeSupportedPage, readDarkModeMirror, setDarkModeActive } from "@/extension/darkMode";
import { darkModeStorage, extensionEnabledStorage } from "@/extension/storage";
import { defineContentScript } from "#imports";

// Runs at document_start (before first paint) so the manifest-listed CSS is already resolvable
// once we toggle the root class. The authoritative setting lives in async browser.storage.local,
// which would still leave a one-frame flash on a cold visit, so we apply a synchronous
// localStorage mirror immediately and reconcile it once storage resolves. This entrypoint only
// handles first paint; SPA navigation and live popup toggles are handled by initExtension in
// src/extension/extension.ts, which the main content script re-runs on href change.
export default defineContentScript({
  matches: ["*://webreg.usc.edu/*"],
  allFrames: true,
  runAt: "document_start",
  cssInjectionMode: "manifest",
  main() {
    if (isDarkModeSupportedPage()) {
      setDarkModeActive(readDarkModeMirror());
    }

    void Promise.all([extensionEnabledStorage.getValue(), darkModeStorage.getValue()]).then(([enabled, darkMode]) => {
      setDarkModeActive(enabled && darkMode && isDarkModeSupportedPage());
    });
  },
});
