import assert from "node:assert/strict";
import test from "node:test";
import { createWindowFetch } from "./windowFetch";

test("calls fetch with the window receiver required by Firefox", async () => {
  const response = {} as Response;
  const targetWindow = {
    fetch(this: unknown) {
      assert.equal(this, targetWindow);
      return Promise.resolve(response);
    },
  } as Pick<Window, "fetch">;

  const result = await createWindowFetch(targetWindow)("https://usc.jonlu.ca/api/data");

  assert.equal(result, response);
});
