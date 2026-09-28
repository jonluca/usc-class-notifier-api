import "@/styles/globals.css";
import { darkPalette } from "@/extension/darkPalette";
import {
  darkModeStorage,
  extensionEnabledStorage,
  showConflictsStorage,
  showUnitsStorage,
  useStorageItem,
} from "@/extension/storage";

function IndexPopup() {
  const [enabled, setEnabled] = useStorageItem(extensionEnabledStorage, true);
  const [showConflicts, setShowConflicts] = useStorageItem(showConflictsStorage, true);
  const [showUnits, setShowUnits] = useStorageItem(showUnitsStorage, true);
  const [darkMode, setDarkMode] = useStorageItem(darkModeStorage, false);

  const labelClass = (disabled: boolean) =>
    `ml-2 text-sm font-medium ${darkMode ? (disabled ? darkPalette.textMuted : darkPalette.textPrimary) : "text-gray-900"}`;
  const checkboxClass = darkMode
    ? `w-5 h-5 rounded-sm bg-transparent ${darkPalette.borderStrong} ${darkPalette.accentCardinal} focus:outline-none`
    : "w-5 h-5 text-blue-600 bg-gray-100 rounded-sm border-gray-300 focus:ring-blue-500";
  const footerLinkClass = darkMode ? `${darkPalette.linkText} ${darkPalette.linkHoverText}` : "";

  return (
    <div className={`px-4 pt-2 pb-1 ${darkMode ? darkPalette.bgSurfaceRaised : "bg-white"}`}>
      <div
        className={`border p-6 space-y-6 rounded-lg min-w-[400px] ${
          darkMode ? `${darkPalette.bgSurface} ${darkPalette.borderDefault}` : "bg-white border-gray-200"
        }`}
      >
        <h1 className={`text-2xl font-bold ${darkMode ? darkPalette.textPrimary : "text-gray-800"}`}>
          USC Schedule Helper
        </h1>
        <div className="flex flex-col space-y-4">
          <div className="flex items-center">
            <input
              id="enable-extension"
              className={checkboxClass}
              type="checkbox"
              checked={enabled}
              onChange={() => setEnabled(!enabled)}
            />
            <label htmlFor="enable-extension" className={labelClass(false)}>
              Enable Extension
            </label>
          </div>
          <div className="flex items-center">
            <input
              id="show-conflicts"
              className={checkboxClass}
              type="checkbox"
              checked={showConflicts}
              onChange={() => setShowConflicts(!showConflicts)}
              disabled={!enabled}
            />
            <label htmlFor="show-conflicts" className={labelClass(!enabled)}>
              Show Class Conflicts
            </label>
          </div>
          <div className="flex items-center">
            <input
              id="show-units"
              className={checkboxClass}
              type="checkbox"
              checked={showUnits}
              onChange={() => setShowUnits(!showUnits)}
              disabled={!enabled}
            />
            <label htmlFor="show-units" className={labelClass(!enabled)}>
              Show Units
            </label>
          </div>
          <div className="flex items-center">
            <input
              id="dark-mode"
              className={checkboxClass}
              type="checkbox"
              checked={darkMode}
              onChange={() => setDarkMode(!darkMode)}
              disabled={!enabled}
            />
            <label htmlFor="dark-mode" className={labelClass(!enabled)}>
              Dark Mode
            </label>
          </div>
        </div>
      </div>
      <p className={`mt-2 ${darkMode ? darkPalette.textMuted : "text-gray-900"}`}>
        <a className={footerLinkClass} href="https://jonlu.ca" rel="noreferrer" target="_blank">
          &copy; {new Date().getFullYear()} JonLuca DeCaro
        </a>{" "}
        -{" "}
        <a
          className={footerLinkClass}
          href="https://github.com/jonluca/USC-Class-Notifier-API"
          rel="noreferrer"
          target="_blank"
        >
          Source Code
        </a>{" "}
        -{" "}
        <a className={footerLinkClass} href="mailto:uscschedulehelper@jonlu.ca" rel="noreferrer" target="_blank">
          Support
        </a>
      </p>
    </div>
  );
}

export default IndexPopup;
