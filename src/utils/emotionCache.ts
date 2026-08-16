import createCache from "@emotion/cache";

export default function createEmotionCache() {
  const insertionPoint =
    globalThis.document?.querySelector<HTMLMetaElement>('meta[name="emotion-insertion-point"]') ?? undefined;

  return createCache({ key: "css", insertionPoint, prepend: true });
}
