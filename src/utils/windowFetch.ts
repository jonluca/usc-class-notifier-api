/**
 * Firefox requires Window.fetch to be called with its Window receiver.
 *
 * tRPC's default browser transport extracts window.fetch before calling it,
 * which loses that receiver in Firefox content scripts.
 */
export function createWindowFetch(targetWindow: Pick<Window, "fetch">): typeof fetch {
  return (input, init) => targetWindow.fetch(input, init);
}
