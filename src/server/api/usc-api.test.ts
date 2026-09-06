import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import axios from "axios";
import { getCourseInformation, getCurrentAvailableCourses, searchClasses } from "./usc-api.ts";

test("all USC requests recover after a stalled response hits its deadline", { timeout: 20_000 }, async (t) => {
  let stall = true;
  const requests = new Set<string>();
  const server = createServer((request, response) => {
    requests.add(request.url || "");
    if (!stall) {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ courses: [] }));
    }
  });
  const originalAdapter = axios.defaults.adapter;
  const httpAdapter = axios.getAdapter("http");
  t.after(() => {
    axios.defaults.adapter = originalAdapter;
    server.closeAllConnections();
    server.close();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  // SAFETY: The server is listening on a TCP port, so its address is AddressInfo.
  const address = server.address() as AddressInfo;
  axios.defaults.adapter = (config) => {
    const url = new URL(config.url!);
    url.protocol = "http:";
    url.hostname = "127.0.0.1";
    url.port = String(address.port);
    return httpAdapter({ ...config, url: url.href, proxy: false });
  };

  await Promise.all(
    [
      getCurrentAvailableCourses({ semester: "20263" }),
      getCourseInformation({ courseCode: "CSCI-310", semester: "20263" }),
      searchClasses({ searchTerm: "CSCI", semester: "20263" }),
    ].map((request) => assert.rejects(request, (error) => axios.isCancel(error))),
  );
  assert.equal(requests.size, 3, "each real request reached the stalled server");

  stall = false;
  assert.deepEqual(await searchClasses({ searchTerm: "CSCI", semester: "20263" }), { courses: [] });
});
