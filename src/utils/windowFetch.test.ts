import assert from "node:assert/strict";
import test from "node:test";
import { createWindowFetch } from "./windowFetch";

test("calls fetch with the window receiver required by Firefox", async () => {
  const response = new Response();
  let observedReceiver: Pick<Window, "fetch"> | undefined;
  const targetWindow: Pick<Window, "fetch"> = {
    fetch() {
      observedReceiver = this;
      return Promise.resolve(response);
    },
  };

  const result = await createWindowFetch(targetWindow)("https://usc.jonlu.ca/api/data");

  assert.equal(observedReceiver, targetWindow);
  assert.equal(result, response);
});
