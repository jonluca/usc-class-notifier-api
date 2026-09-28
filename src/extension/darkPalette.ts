// Single source of truth for the Tailwind classes our own React UI (the popup, the
// NotificationModal) uses to mirror the --ush-* custom properties defined in
// src/styles/webregDark.css. That file is plain CSS scoped to html.usc-helper-dark on WebReg
// pages, so it can't be reached from these two components: the popup is its own document, and
// the modal's Tailwind output is compiled separately (see the cascade-layers note in
// docs/dark-mode-handoff.md). Keeping the literal token here, once, means a palette change only
// needs updating in two places (here + webregDark.css) instead of three.
//
// These must stay complete, literal strings, each its own object value - Tailwind finds classes
// by scanning source text for exact candidate strings, not by evaluating JS at runtime. Something
// built by concatenating pieces at a call site (e.g. `${hex}!` to add !important) produces a
// string Tailwind never sees as a whole, so it's never generated - confirmed by testing a broken
// version of this file. Every full class token used anywhere needs its own named entry here.
export const darkPalette = {
  bgSurface: "bg-[#0d0d0d]", // --ush-surface
  bgSurfaceRaised: "bg-[#161616]", // --ush-surface-raised
  borderDefault: "border-[#2a2a2a]", // --ush-border
  borderStrong: "border-[#3d3d3d]", // --ush-border-strong
  textPrimary: "text-[#e8e8ec]", // --ush-text
  textMuted: "text-[#9a9aa2]", // --ush-text-muted
  textMutedImportant: "text-[#9a9aa2]!", // --ush-text-muted, !important
  linkText: "text-[#ff9a9a]", // --ush-link
  linkHoverText: "hover:text-[#ffb8b8]", // --ush-link-hover
  accentCardinal: "accent-[#8b0000]", // --ush-cardinal
} as const;
