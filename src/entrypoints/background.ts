import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import {
  calendarMetadataError,
  calendarMetadataRequestSchema,
  loadUSCCalendarMetadata,
  type CalendarMetadataResponse,
} from "@/extension/uscCalendarMetadata";

function isWebRegSender(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  try {
    return new URL(url).origin === "https://webreg.usc.edu";
  } catch {
    return false;
  }
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message, sender): Promise<CalendarMetadataResponse> | undefined => {
    const request = calendarMetadataRequestSchema.safeParse(message);
    if (!request.success) {
      return undefined;
    }
    if (!isWebRegSender(sender.url)) {
      return Promise.resolve({ ok: false, error: "Calendar metadata requests are only allowed from WebReg." });
    }

    return loadUSCCalendarMetadata(request.data)
      .then((metadata) => ({ ok: true as const, metadata }))
      .catch(calendarMetadataError);
  });
});
