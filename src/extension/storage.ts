import { storage } from "@wxt-dev/storage";
import { useEffect, useState } from "react";

interface DefinedStorageItem<T> {
  getValue: () => Promise<T>;
  setValue: (value: T) => Promise<void>;
  watch: (callback: (newValue: T, oldValue: T | null) => void) => () => void;
}

export const extensionEnabledStorage = storage.defineItem<boolean>("local:extensionEnabled", {
  fallback: true,
});

export const showConflictsStorage = storage.defineItem<boolean>("local:showConflicts", {
  fallback: true,
});

export const showUnitsStorage = storage.defineItem<boolean>("local:showUnits", {
  fallback: true,
});

export const darkModeStorage = storage.defineItem<boolean>("local:darkMode", {
  fallback: false,
});

// The My Week tab and drawer on course-search pages. On by default so people find it.
export const showWeekPreviewStorage = storage.defineItem<boolean>("local:showWeekPreview", {
  fallback: true,
});

// Whether the week calendar was left open. Starts minimized; after that, remembers the last choice.
// Panel state only, deliberately not part of Options, so opening or minimizing it never re-runs the extension.
export const weekPreviewOpenStorage = storage.defineItem<boolean>("local:weekPreviewOpen", {
  fallback: false,
});

export type WeekPreviewSide = "left" | "right";

// Which bottom corner the week calendar sits in. Left covers the start of course names; right covers the Add buttons.
// Set in the popup; like the open state, not part of Options, so changing it never re-runs the extension.
export const weekPreviewSideStorage = storage.defineItem<WeekPreviewSide>("local:weekPreviewSide", {
  fallback: "left",
});

export function useStorageItem<T>(item: DefinedStorageItem<T>, initialValue: T) {
  const [value, setValue] = useState(initialValue);
  const [isLoaded, setIsLoaded] = useState(false);
  useEffect(() => {
    let isMounted = true;

    item.getValue().then((storedValue) => {
      if (isMounted) {
        setValue(storedValue);
        setIsLoaded(true);
      }
    });

    const unwatch = item.watch((newValue) => {
      if (isMounted) {
        setValue(newValue);
        setIsLoaded(true);
      }
    });

    return () => {
      isMounted = false;
      unwatch();
    };
  }, [item]);

  const updateValue = async (nextValue: T) => {
    await item.setValue(nextValue);
  };

  return [value, updateValue, isLoaded] as const;
}
