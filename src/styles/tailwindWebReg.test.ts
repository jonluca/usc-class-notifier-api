// Tailwind turns any word that looks like a class name in our source (even in a comment) into a utility, and
// the extension's CSS is injected into WebReg. If that word is also a class WebReg uses, the utility restyles
// WebReg itself: ".collapse { visibility: collapse }" hid WebReg's navbar and course panels twice before.
// This runs Tailwind on the real stylesheet and source, then checks the result against WebReg's own classes.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const globalsCss = `${here}globals.css`;
const fixturesDir = `${here}../extension/fixtures/`;

// Bootstrap 3 state classes WebReg toggles at runtime, which a static capture may not contain.
const BOOTSTRAP_STATE_CLASSES = [
  "collapse",
  "collapsing",
  "in",
  "fade",
  "show",
  "active",
  "open",
  "visible",
  "invisible",
];

function webRegClassNames() {
  const names = new Set(BOOTSTRAP_STATE_CLASSES);
  for (const file of readdirSync(fixturesDir).filter((name) => name.endsWith(".html"))) {
    for (const match of readFileSync(`${fixturesDir}${file}`, "utf8").matchAll(/class="([^"]*)"/g)) {
      for (const name of match[1]!.split(/\s+/).filter(Boolean)) {
        names.add(name);
      }
    }
  }
  return names;
}

async function buildExtensionCss() {
  const resolve = createRequire(import.meta.url);
  const pluginPath = resolve.resolve("@tailwindcss/postcss");
  const fromPlugin = createRequire(pluginPath);
  interface PostcssPlugin {
    postcssPlugin: string;
  }
  // SAFETY: postcss's default export is the processor factory, and @tailwindcss/postcss's default export is a
  // factory returning a PostCSS plugin object; these are the only members this test calls.
  const postcss = (await import(pathToFileURL(fromPlugin.resolve("postcss")).href)).default as (
    plugins: PostcssPlugin[],
  ) => { process(css: string, options: { from: string }): Promise<{ css: string }> };
  // SAFETY: see above.
  const tailwind = (await import(pathToFileURL(pluginPath).href)).default as () => PostcssPlugin;
  const result = await postcss([tailwind()]).process(readFileSync(globalsCss, "utf8"), { from: globalsCss });
  return result.css;
}

test("Tailwind generates no rule for a class name WebReg itself uses", { timeout: 60_000 }, async () => {
  const css = await buildExtensionCss();
  const generated = new Set([...css.matchAll(/(?:^|[\s,}])\.([a-zA-Z][\w-]*)(?=[\s,{:.[>])/g)].map((m) => m[1]!));
  assert.ok(generated.size > 20, "sanity: Tailwind produced utilities for our own classes");
  const clashes = [...webRegClassNames()].filter((name) => generated.has(name)).sort();
  assert.deepEqual(
    clashes,
    [],
    "Find the word in our source (often a comment) and rephrase it, or exclude that file in globals.css",
  );
});
