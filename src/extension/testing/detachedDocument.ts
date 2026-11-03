// Node-only helper for tests and tools/: parse HTML into a real detached Document using the LinkeDOM
// copy WXT already depends on (same approach as courseBinDom.test.ts). Never imported by extension code.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

interface ServerDomParser {
  parseFromString(html: string, type: "text/html"): Document;
}

export async function parseDetachedDocument(html: string): Promise<Document> {
  const resolveFromHere = createRequire(import.meta.url);
  const resolveFromWxt = createRequire(resolveFromHere.resolve("wxt"));
  const linkedomPath = resolveFromWxt.resolve("linkedom");
  // SAFETY: LinkeDOM's documented module export is a constructable DOMParser with this method.
  const linkedom = (await import(pathToFileURL(linkedomPath).href)) as {
    DOMParser: new () => ServerDomParser;
  };
  return new linkedom.DOMParser().parseFromString(html, "text/html");
}
