import assert from "node:assert/strict";
import { createRequire, register } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";

// The popup imports its stylesheet; Node can't load CSS, so stub .css files as empty modules for this test.
const cssStub = `export async function load(url, context, next) {
  return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(cssStub)}`);

type StoredSetting = "extensionEnabled" | "showConflicts" | "showUnits" | "darkMode" | "showWeekPreview";
type StoredSettings = Partial<Record<StoredSetting, boolean>> & { weekPreviewSide?: "left" | "right" };
interface FakeBrowser {
  reset(): void;
  storage: { local: { get(): Promise<StoredSettings>; set(items: StoredSettings): Promise<void> } };
}

// Mounts the real popup in a LinkeDOM document, backed by WXT's in-memory fake extension storage.
async function setUp() {
  const resolveFromTest = createRequire(import.meta.url);
  const resolveFromWxt = createRequire(resolveFromTest.resolve("wxt"));
  // SAFETY: each caller names the module and states the shape of the exports it uses.
  const load = async <T,>(name: string) => (await import(pathToFileURL(resolveFromWxt.resolve(name)).href)) as T;
  const { fakeBrowser } = await load<{ fakeBrowser: FakeBrowser }>("@webext-core/fake-browser");
  // SAFETY: LinkeDOM supplies the DOM interfaces React needs to mount and dispatch events.
  const { parseHTML } = await load<{
    parseHTML: (html: string) => { document: Document; window: Window & typeof globalThis };
  }>("linkedom");
  const dom = parseHTML("<!doctype html><html><body><div id=root></div></body></html>");
  Object.assign(globalThis, {
    chrome: fakeBrowser,
    browser: fakeBrowser,
    window: dom.window,
    document: dom.document,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLSelectElement: dom.window.HTMLSelectElement,
    Node: dom.window.Node,
    Event: dom.window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: IndexPopup } = await import("@/popup/index");
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

  const mount = async (stored: StoredSettings) => {
    fakeBrowser.reset();
    await fakeBrowser.storage.local.set(stored);
    dom.document.body.innerHTML = "<div id=root></div>";
    const root = createRoot(dom.document.getElementById("root")!);
    await React.act(async () => {
      root.render(React.createElement(IndexPopup));
    });
    // Let the storage reads in useStorageItem resolve and re-render.
    await React.act(settle);
    // SAFETY: every id passed in belongs to an <input> the popup renders.
    const input = (id: string) => dom.document.getElementById(id) as HTMLInputElement;
    const label = (id: string) => dom.document.querySelector(`label[for="${id}"]`)!;
    const click = async (id: string) => {
      await React.act(async () => {
        input(id).dispatchEvent(new dom.window.Event("click", { bubbles: true }));
        await settle();
      });
    };
    // SAFETY: the one select the popup renders is the Week Preview corner.
    const corner = () => dom.document.getElementById("week-preview-side") as HTMLSelectElement;
    const pickCorner = async (value: string) => {
      await React.act(async () => {
        // LinkeDOM has no value setter on <select>; marking the option selected is what choosing it does.
        for (const option of corner().querySelectorAll("option")) {
          option.toggleAttribute("selected", option.value === value);
        }
        corner().dispatchEvent(new dom.window.Event("change", { bubbles: true }));
        await settle();
      });
    };
    const unmount = () => React.act(async () => root.unmount());
    return { input, label, click, corner, pickCorner, unmount, stored: () => fakeBrowser.storage.local.get() };
  };
  return { mount, document: dom.document };
}

const ready = setUp();

test("the popup lists Show Week Preview right after Show Class Conflicts", async () => {
  const { mount, document } = await ready;
  const popup = await mount({});
  const labels = [...document.querySelectorAll("label")].map((l) => [l.getAttribute("for"), l.textContent]);
  assert.deepEqual(labels, [
    ["enable-extension", "Enable Extension"],
    ["show-conflicts", "Show Class Conflicts"],
    ["show-week-preview", "Show Week Preview"],
    ["show-units", "Show Units"],
    ["dark-mode", "Dark Mode"],
  ]);
  await popup.unmount();
});

test("the checkbox shows the saved Show Week Preview value, not another setting's", async () => {
  const { mount } = await ready;
  const off = await mount({ showWeekPreview: false });
  assert.equal(off.input("show-week-preview").checked, false);
  assert.equal(off.input("show-conflicts").checked, true);
  await off.unmount();

  const conflictsOff = await mount({ showConflicts: false });
  assert.equal(conflictsOff.input("show-week-preview").checked, true, "defaults to on");
  await conflictsOff.unmount();
});

test("clicking it saves Show Week Preview and leaves the other settings alone", async () => {
  const { mount } = await ready;
  const popup = await mount({});
  await popup.click("show-week-preview");
  assert.deepEqual(await popup.stored(), { showWeekPreview: false });
  assert.equal(popup.input("show-week-preview").checked, false);
  await popup.click("show-week-preview");
  assert.deepEqual(await popup.stored(), { showWeekPreview: true });
  await popup.unmount();
});

test("it is disabled while the extension is off, styled exactly like the other settings", async () => {
  const { mount } = await ready;
  for (const darkMode of [false, true]) {
    const popup = await mount({ extensionEnabled: false, darkMode });
    assert.equal(popup.input("show-week-preview").disabled, true);
    assert.equal(popup.input("show-week-preview").className, popup.input("show-conflicts").className);
    assert.equal(popup.label("show-week-preview").className, popup.label("show-conflicts").className);
    await popup.unmount();
  }
  // In dark mode the disabled labels are muted (light mode never greys them; that's existing behavior).
  const dark = await mount({ extensionEnabled: false, darkMode: true });
  assert.notEqual(dark.label("show-week-preview").className, dark.label("enable-extension").className);
  await dark.unmount();
});

test("the Week Preview corner sits in the Show Week Preview row and is named for screen readers", async () => {
  const { mount } = await ready;
  const popup = await mount({});
  assert.equal(popup.corner().parentElement, popup.input("show-week-preview").parentElement);
  assert.equal(popup.corner().getAttribute("aria-label"), "Week Preview corner");
  await popup.unmount();
});

test("the Week Preview corner shows the saved choice, bottom-left by default, and saves only itself", async () => {
  const { mount } = await ready;
  const fresh = await mount({});
  assert.equal(fresh.corner().value, "left");
  await fresh.pickCorner("right");
  assert.deepEqual(await fresh.stored(), { weekPreviewSide: "right" });
  assert.equal(fresh.corner().value, "right");
  await fresh.pickCorner("left");
  assert.deepEqual(await fresh.stored(), { weekPreviewSide: "left" });
  await fresh.unmount();

  const saved = await mount({ weekPreviewSide: "right" });
  assert.equal(saved.corner().value, "right");
  await saved.unmount();
});

test("the corner can't be changed while the extension or Week Preview is off", async () => {
  const { mount } = await ready;
  for (const [stored, disabled] of [
    [{}, false],
    [{ extensionEnabled: false }, true],
    [{ showWeekPreview: false }, true],
  ] as const) {
    const popup = await mount(stored);
    assert.equal(popup.corner().disabled, disabled, JSON.stringify(stored));
    await popup.unmount();
  }
});
