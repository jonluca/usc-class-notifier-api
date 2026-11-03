import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import {
  calendarMetadataError,
  calendarMetadataRequestSchema,
  loadUSCCalendarMetadata,
  type CalendarMetadataResponse,
} from "@/extension/uscCalendarMetadata";
import {
  FINAL_EXAMS_PERMISSION_PAGE,
  fetchFinalExamsPage,
  finalExamsPageRequestSchema,
  openFinalExamsPermissionSchema,
  type FinalExamsPageResponse,
} from "@/extension/finalExamsMessages";

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

async function openFinalExamsPermissionPage(): Promise<void> {
  const url = browser.runtime.getURL(FINAL_EXAMS_PERMISSION_PAGE);
  if (browser.windows) {
    await browser.windows.create({ url, type: "popup", width: 460, height: 360 });
  } else {
    await browser.tabs.create({ url });
  }
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message, sender): Promise<FinalExamsPageResponse> | undefined => {
    if (!finalExamsPageRequestSchema.safeParse(message).success) {
      return undefined;
    }
    if (!isWebRegSender(sender.url)) {
      return Promise.resolve({
        ok: false,
        reason: "network",
        error: "Final exam requests are only allowed from WebReg.",
      });
    }
    return fetchFinalExamsPage(browser.permissions);
  });

  browser.runtime.onMessage.addListener((message, sender): Promise<boolean> | undefined => {
    if (!openFinalExamsPermissionSchema.safeParse(message).success) {
      return undefined;
    }
    if (!isWebRegSender(sender.url)) {
      return Promise.resolve(false);
    }
    return openFinalExamsPermissionPage().then(
      () => true,
      () => false,
    );
  });

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
