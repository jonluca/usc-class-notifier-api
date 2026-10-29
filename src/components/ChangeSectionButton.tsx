import { useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@mui/material";
import type { RouterOutputs } from "@/utils/api";
import { SectionSearch } from "./SectionSearch";

type Section = RouterOutputs["user"]["getWatchedClasses"][number];

export function ChangeSectionButton({ section }: { section: Section }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="min-h-11 rounded-lg border border-gray-400 px-4 py-2 text-sm font-semibold hover:bg-gray-100 disabled:opacity-50"
        disabled={!section.canChangeSection}
        onClick={() => setOpen(true)}
        aria-label={`Change paid section ${section.section}`}
      >
        Change section
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        fullWidth
        maxWidth="md"
        aria-labelledby={`change-${section.id}`}
      >
        <DialogTitle id={`change-${section.id}`} className="flex items-center justify-between gap-3">
          <span>
            Change paid alerts · {section.ClassInfo?.courseNumber} · {section.section}
          </span>
          <button type="button" className="min-h-11 px-3 text-sm underline" onClick={() => setOpen(false)}>
            Close
          </button>
        </DialogTitle>
        <DialogContent>
          <SectionSearch changingSection={section} onComplete={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}
