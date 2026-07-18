import type { ProjectSnapshot } from "./types";
import { PROJECT_FORMAT, PROJECT_VERSION } from "./types";

const DATABASE = "dropfit-studio";
const STORE = "projects";
const AUTOSAVE_KEY = "autosave-v1";

interface AutosaveRecord {
  format: typeof PROJECT_FORMAT;
  version: typeof PROJECT_VERSION;
  snapshot: ProjectSnapshot;
}

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open autosave storage"));
  });
}

export async function loadAutosave(): Promise<ProjectSnapshot | null> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(AUTOSAVE_KEY);
      request.onsuccess = () => {
        const record = request.result as AutosaveRecord | undefined;
        if (!record) {
          resolve(null);
          return;
        }
        if (record.format !== PROJECT_FORMAT || record.version !== PROJECT_VERSION) {
          reject(new Error("The autosave uses an unsupported project version"));
          return;
        }
        resolve(record.snapshot);
      };
      request.onerror = () => reject(request.error ?? new Error("Could not load autosave"));
    });
  } finally {
    db.close();
  }
}

export async function saveAutosave(snapshot: ProjectSnapshot): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const record: AutosaveRecord = { format: PROJECT_FORMAT, version: PROJECT_VERSION, snapshot };
      const request = db.transaction(STORE, "readwrite").objectStore(STORE).put(record, AUTOSAVE_KEY);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("Could not save autosave"));
    });
  } finally {
    db.close();
  }
}
