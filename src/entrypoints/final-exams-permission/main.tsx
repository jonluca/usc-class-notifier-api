import "@/styles/globals.css";
import { storage } from "@wxt-dev/storage";
import { useState } from "react";
import ReactDOM from "react-dom/client";
import { browser } from "wxt/browser";
import { FINAL_EXAMS_ORIGIN, FINAL_EXAMS_PERMISSION_CHANGED_KEY } from "@/extension/finalExamsMessages";

type Status = "idle" | "granted" | "declined" | "error";

// Opened from the Final Exams modal on WebReg. browser.permissions.request needs a user gesture on an
// extension page; content scripts can't call it, so this tiny page exists only to host that click.
function PermissionPage() {
  const [status, setStatus] = useState<Status>("idle");

  const allow = async () => {
    try {
      const granted = await browser.permissions.request({ origins: [FINAL_EXAMS_ORIGIN] });
      setStatus(granted ? "granted" : "declined");
      if (granted) {
        await storage.setItem(FINAL_EXAMS_PERMISSION_CHANGED_KEY, Date.now());
        window.setTimeout(() => window.close(), 1200);
      }
    } catch {
      setStatus("error");
    }
  };

  return (
    <main className="p-6 font-sans text-sm text-gray-900 space-y-4 max-w-md">
      <h1 className="text-lg font-bold">Live final exam schedule</h1>
      <p>
        USC Schedule Helper can read the registrar's public final exam page (arr.usc.edu) so your exam list stays
        current when the registrar updates it. It reads only that page and sends nothing anywhere.
      </p>
      <p>Without it, the extension uses the copy bundled with this version.</p>
      {status === "idle" && (
        <button
          type="button"
          className="px-4 py-2 rounded bg-red-800 text-white font-semibold"
          onClick={() => void allow()}
        >
          Allow arr.usc.edu
        </button>
      )}
      {status === "granted" && <p className="font-semibold">Done. You can close this window.</p>}
      {status === "declined" && <p>No problem. The bundled schedule will be used. You can close this window.</p>}
      {status === "error" && <p>Your browser didn't allow the request. The bundled schedule will be used.</p>}
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<PermissionPage />);
