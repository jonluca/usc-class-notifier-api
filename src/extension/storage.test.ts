import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";

// @wxt-dev/storage reads the extension API when it is imported, so install WXT's fake browser first.
async function loadStorage() {
  const resolveFromTest = createRequire(import.meta.url);
  const resolveFromWxt = createRequire(resolveFromTest.resolve("wxt"));
  // SAFETY: @webext-core/fake-browser exports an in-memory implementation of the WebExtension API.
  const { fakeBrowser } = (await import(pathToFileURL(resolveFromWxt.resolve("@webext-core/fake-browser")).href)) as {
    fakeBrowser: {
      reset(): void;
      storage: { local: { get(): Promise<{ showWeekPreview?: boolean; weekPreviewOpen?: boolean }> } };
    };
  };
  Object.assign(globalThis, { chrome: fakeBrowser, browser: fakeBrowser });
  const storage = await import("@/extension/storage");
  return { fakeBrowser, ...storage };
}

const loaded = loadStorage();

test("Show Week Preview is on, and the week calendar starts minimized, for someone who never touched them", async () => {
  const { fakeBrowser, showWeekPreviewStorage, weekPreviewOpenStorage } = await loaded;
  fakeBrowser.reset();
  assert.equal(await showWeekPreviewStorage.getValue(), true);
  assert.equal(await weekPreviewOpenStorage.getValue(), false);
});

test("both choices are remembered, independently of each other and of the existing settings", async () => {
  const storage = await loaded;
  storage.fakeBrowser.reset();
  await storage.weekPreviewOpenStorage.setValue(true);
  assert.equal(await storage.weekPreviewOpenStorage.getValue(), true);
  assert.equal(await storage.showWeekPreviewStorage.getValue(), true);

  await storage.showWeekPreviewStorage.setValue(false);
  assert.equal(await storage.showWeekPreviewStorage.getValue(), false);
  assert.equal(await storage.weekPreviewOpenStorage.getValue(), true, "turning the feature off keeps the panel choice");
  assert.equal(await storage.showConflictsStorage.getValue(), true);
  assert.equal(await storage.extensionEnabledStorage.getValue(), true);
  assert.deepEqual(await storage.fakeBrowser.storage.local.get(), { showWeekPreview: false, weekPreviewOpen: true });
});

test("every setting has its own storage key, in local storage", async () => {
  const storage = await loaded;
  const items = [
    storage.extensionEnabledStorage,
    storage.showConflictsStorage,
    storage.showUnitsStorage,
    storage.darkModeStorage,
    storage.showWeekPreviewStorage,
    storage.weekPreviewOpenStorage,
  ];
  const keys = items.map((item) => item.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.every((key) => key.startsWith("local:")));
});
