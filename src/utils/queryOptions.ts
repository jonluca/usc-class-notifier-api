import type { DefaultOptions } from "@tanstack/react-query";

export const queryClientDefaults = {
  queries: {
    staleTime: 15 * 60_000,
    networkMode: "always",
  },
  mutations: {
    networkMode: "always",
  },
} satisfies DefaultOptions;

// Payment processing and notification delivery update these rows outside the dashboard.
export const watchedClassesQueryOptions = {
  staleTime: 0,
  refetchInterval: 60_000,
  refetchIntervalInBackground: false,
};
