// "Final Exams" button on /myCourseBin plus a tiny open/close store the React modal subscribes to.
// The button is an <a role="button" class="btn btn-default"> like its Expand All / Collapse All
// neighbours, so WebReg's own styles (and webregDark.css) apply and nothing fights WebReg's
// unlayered `button` rules.

import $ from "jquery";
import { useSyncExternalStore } from "react";

export const FINAL_EXAMS_BUTTON_CLASS = "usc-helper-final-exams";

let modalOpen = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

export function openFinalExamsModal() {
  modalOpen = true;
  emit();
}

export function closeFinalExamsModal() {
  if (modalOpen) {
    modalOpen = false;
    emit();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useFinalExamsModalOpen(): boolean {
  return useSyncExternalStore(subscribe, () => modalOpen);
}

export function insertFinalExamsButton() {
  const holder = $(".btn-group.buttonHolder").first();
  if (holder.length === 0) {
    return;
  }
  $(`.${FINAL_EXAMS_BUTTON_CLASS}`).remove();
  holder.append(`<a role="button" class="btn btn-default ${FINAL_EXAMS_BUTTON_CLASS}" href="#">Final Exams</a>`);
  $(`.${FINAL_EXAMS_BUTTON_CLASS}`)
    .off("click.usc-helper-final-exams")
    .on("click.usc-helper-final-exams", (event) => {
      event.preventDefault();
      // WebReg's accordion headers toggle on click; don't let this bubble into them.
      event.stopPropagation();
      openFinalExamsModal();
    });
}

export function removeFinalExamsButton() {
  $(`.${FINAL_EXAMS_BUTTON_CLASS}`).remove();
  closeFinalExamsModal();
}
