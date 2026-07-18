import { useEffect, useState } from "react";
import { captureProjectSnapshot, useStore } from "../state/store";
import { loadAutosave, saveAutosave } from "./autosave";

const AUTOSAVE_DELAY_MS = 600;

function projectChanged(
  state: ReturnType<typeof useStore.getState>,
  previous: ReturnType<typeof useStore.getState>,
): boolean {
  return state.projectName !== previous.projectName
    || state.items !== previous.items
    || state.params !== previous.params
    || state.cutouts !== previous.cutouts
    || state.connections !== previous.connections;
}

/** Restore the last local project once, then persist project edits to IndexedDB. */
export function useProjectPersistence(): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let disposed = false;
    let timer: number | null = null;
    let unsubscribe: (() => void) | null = null;

    const persistNow = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      void saveAutosave(captureProjectSnapshot(useStore.getState())).catch(() => {
        // Autosave is best-effort. Explicit .dropfit saves remain available if
        // storage is disabled or full.
      });
    };

    void loadAutosave()
      .then((snapshot) => {
        if (!disposed && snapshot) {
          useStore.getState().loadProject(snapshot, { recordHistory: false });
        }
      })
      .catch((error: unknown) => {
        if (!disposed) useStore.getState().setError(`Autosave restore failed: ${(error as Error).message}`);
      })
      .finally(() => {
        if (disposed) return;
        setReady(true);
        unsubscribe = useStore.subscribe((state, previous) => {
          if (!projectChanged(state, previous)) return;
          if (timer !== null) window.clearTimeout(timer);
          timer = window.setTimeout(persistNow, AUTOSAVE_DELAY_MS);
        });
        window.addEventListener("pagehide", persistNow);
      });

    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      unsubscribe?.();
      window.removeEventListener("pagehide", persistNow);
    };
  }, []);

  return ready;
}
