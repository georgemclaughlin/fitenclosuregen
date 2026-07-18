import * as Comlink from "comlink";
import type { WorkerApi } from "./worker";
import type { GenerateRequest, GenerateResult } from "./types";

let worker: Worker | null = null;
let proxy: Comlink.Remote<WorkerApi> | null = null;
let completedOnWorker = 0;

// Manifold uses an Emscripten heap. Recycling the worker periodically releases
// every short-lived CSG allocation, including intermediates created inside
// chained boolean operations that cannot be disposed individually here.
const MAX_GENERATIONS_PER_WORKER = 20;

interface PendingGeneration {
  request: GenerateRequest;
  resolve: (result: GenerateResult) => void;
  reject: (error: unknown) => void;
}

let running = false;
let pending: PendingGeneration | null = null;

export class GenerationSupersededError extends Error {
  constructor() {
    super("Generation superseded by a newer request");
    this.name = "GenerationSupersededError";
  }
}

function getProxy(): Comlink.Remote<WorkerApi> {
  if (!proxy) {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    proxy = Comlink.wrap<WorkerApi>(worker);
  }
  return proxy;
}

function disposeWorker(): void {
  if (proxy) proxy[Comlink.releaseProxy]();
  worker?.terminate();
  proxy = null;
  worker = null;
  completedOnWorker = 0;
}

async function runGeneration(request: GenerateRequest): Promise<GenerateResult> {
  try {
    const result = await getProxy().generate(request);
    completedOnWorker += 1;
    if (completedOnWorker >= MAX_GENERATIONS_PER_WORKER) disposeWorker();
    return result;
  } catch (error) {
    // A failed worker can be left with a corrupted WASM heap. Start clean on
    // the next request instead of keeping the failed instance around.
    disposeWorker();
    throw error;
  }
}

async function drainQueue(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (pending) {
      const current = pending;
      pending = null;
      try {
        current.resolve(await runGeneration(current.request));
      } catch (error) {
        current.reject(error);
      }
    }
  } finally {
    running = false;
    // A request can arrive after the final loop check but before `running`
    // flips back to false.
    if (pending) void drainQueue();
  }
}

/**
 * Run one generation at a time and keep at most the newest pending request.
 * The active CSG operation cannot be interrupted synchronously, but stale
 * requests no longer build up behind it.
 */
export function generate(request: GenerateRequest): Promise<GenerateResult> {
  return new Promise((resolve, reject) => {
    if (pending) pending.reject(new GenerationSupersededError());
    pending = { request, resolve, reject };
    void drainQueue();
  });
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", disposeWorker);
}
