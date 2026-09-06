import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { environmentManager, focusManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import { queryClientDefaults, watchedClassesQueryOptions } from "./queryOptions";

test("watched classes refresh after returning to the dashboard and after payment processing", async (context) => {
  const wasServer = environmentManager.isServer();
  environmentManager.setIsServer(() => false);
  focusManager.setFocused(true);
  context.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"] });
  const client = new QueryClient({ defaultOptions: queryClientDefaults });
  client.mount();
  context.after(() => {
    client.unmount();
    client.clear();
    focusManager.setFocused(undefined);
    environmentManager.setIsServer(() => wasServer);
  });

  let isPaid = false;
  let watchReads = 0;
  const watchQuery = {
    ...watchedClassesQueryOptions,
    queryKey: ["watched-classes"],
    queryFn: async () => {
      watchReads += 1;
      return [{ id: "watch", isPaid }];
    },
  };
  await client.prefetchQuery(watchQuery);
  const watchObserver = new QueryObserver(client, watchQuery);
  let unsubscribeWatch = watchObserver.subscribe(() => {});
  context.after(() => unsubscribeWatch());
  await setImmediate();
  assert.equal(watchReads, 2, "remount reads fresh watch data even when its cached data is recent");

  let userReads = 0;
  const userObserver = new QueryObserver(client, {
    queryKey: ["user-info"],
    queryFn: async () => {
      userReads += 1;
      return { email: "student@example.com" };
    },
  });
  const unsubscribeUser = userObserver.subscribe(() => {});
  context.after(unsubscribeUser);
  await setImmediate();

  focusManager.setFocused(false);
  isPaid = true;
  context.mock.timers.tick(60_000);
  await setImmediate();
  assert.equal(watchReads, 2, "hidden dashboards do not poll");
  assert.equal(watchObserver.getCurrentResult().data?.[0]?.isPaid, false);

  focusManager.setFocused(true);
  await setImmediate();
  assert.equal(watchReads, 3);
  assert.equal(watchObserver.getCurrentResult().data?.[0]?.isPaid, true, "returning from payment refreshes the card");
  assert.equal(userReads, 1, "fresh account data is not refetched alongside the watches");

  isPaid = false;
  context.mock.timers.tick(59_999);
  await setImmediate();
  assert.equal(watchReads, 3, "foreground polling is bounded to once per minute");
  context.mock.timers.tick(1);
  await setImmediate();
  assert.equal(watchReads, 4);
  assert.equal(watchObserver.getCurrentResult().data?.[0]?.isPaid, false, "an open dashboard receives worker updates");
  assert.equal(userReads, 1, "other queries do not acquire a polling interval");

  unsubscribeWatch();
  context.mock.timers.tick(60_000);
  await setImmediate();
  assert.equal(watchReads, 4, "leaving the dashboard stops polling");

  unsubscribeWatch = watchObserver.subscribe(() => {});
  await setImmediate();
  assert.equal(watchReads, 5, "returning to a cached dashboard refreshes it");
});
