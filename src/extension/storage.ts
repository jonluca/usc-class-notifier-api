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
