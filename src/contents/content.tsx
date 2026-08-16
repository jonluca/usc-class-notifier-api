import React, { useEffect, useState } from "react";
import { initExtension } from "@/extension/extension";
import { AppContext, context, useScheduleHelperContext } from "@/extension/context";
import { CssBaseline } from "@mui/material";
import { CacheProvider } from "@emotion/react";
import createCache from "@emotion/cache";
import NotificationModal from "@/extension/notification";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { trpc, trpcClient } from "@/extension/data";
import { ToastContainer } from "react-toastify";
import { extensionEnabledStorage, showConflictsStorage, showUnitsStorage, useStorageItem } from "@/extension/storage";

const LOCATION_CHANGE_EVENT = "usc-schedule-helper:locationchange";

type HistoryMethodName = "pushState" | "replaceState";
type HistoryMethod = History["pushState"];

function useLocationHref() {
  const [href, setHref] = useState(() => window.location.href);

  useEffect(() => {
    const updateHref = () => {
      const nextHref = window.location.href;
      setHref((currentHref) => (currentHref === nextHref ? currentHref : nextHref));
    };

    const patchHistoryMethod = (methodName: HistoryMethodName) => {
      const originalMethod: HistoryMethod = window.history[methodName];
      const callOriginalMethod = originalMethod.bind(window.history);

      const patchedHistoryMethod: HistoryMethod = (...args) => {
        const result = callOriginalMethod(...args);
        window.dispatchEvent(new Event(LOCATION_CHANGE_EVENT));
        return result;
      };
      window.history[methodName] = patchedHistoryMethod;

      return () => {
        window.history[methodName] = originalMethod;
      };
    };

    const restorePushState = patchHistoryMethod("pushState");
    const restoreReplaceState = patchHistoryMethod("replaceState");

    window.addEventListener(LOCATION_CHANGE_EVENT, updateHref);
    window.addEventListener("popstate", updateHref);
    window.addEventListener("hashchange", updateHref);

    return () => {
      restorePushState();
      restoreReplaceState();
      window.removeEventListener(LOCATION_CHANGE_EVENT, updateHref);
      window.removeEventListener("popstate", updateHref);
      window.removeEventListener("hashchange", updateHref);
    };
  }, []);

  return href;
}

const Providers = ({ children }: { children: React.ReactNode }) => {
  const [queryClient] = useState(() => new QueryClient());
  const [styleCache] = useState(() =>
    createCache({
      key: "wxt-mui-cache",
      prepend: true,
      container: document.head ?? document.documentElement,
    }),
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <CacheProvider value={styleCache}>
          <AppContext.Provider value={context}>{children}</AppContext.Provider>
        </CacheProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
};

const ExtensionLogic = () => {
  const [enabled, , enabledLoaded] = useStorageItem(extensionEnabledStorage, true);
  const [showConflicts, , showConflictsLoaded] = useStorageItem(showConflictsStorage, true);
  const [showUnits, , showUnitsLoaded] = useStorageItem(showUnitsStorage, true);
  const href = useLocationHref();
  const selectedClass = useScheduleHelperContext((state) => state.selectedClass);

  useEffect(() => {
    if (!enabledLoaded || !showConflictsLoaded || !showUnitsLoaded) {
      return;
    }

    return initExtension({
      enabled,
      showConflicts,
      showUnits,
    });
  }, [enabled, enabledLoaded, href, showConflicts, showConflictsLoaded, showUnits, showUnitsLoaded]);

  if (!selectedClass) {
    return null;
  }
  return <NotificationModal />;
};

const ExtensionView = () => {
  useEffect(() => {
    window.dataLayer = window.dataLayer || [];
    window.gtag = function gtag() {
      window.dataLayer.push(arguments); // oxlint-disable-line
    };
    window.gtag("js", new Date());
  }, []);
  return (
    <Providers>
      <CssBaseline />
      <ToastContainer />
      <ExtensionLogic />
    </Providers>
  );
};

export default ExtensionView;
