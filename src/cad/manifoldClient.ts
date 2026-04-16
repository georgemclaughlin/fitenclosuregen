import * as Comlink from "comlink";
import type { WorkerApi } from "./worker";
import type { GenerateRequest, GenerateResult } from "./types";

let worker: Worker | null = null;
let proxy: Comlink.Remote<WorkerApi> | null = null;

function getProxy(): Comlink.Remote<WorkerApi> {
  if (!proxy) {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    proxy = Comlink.wrap<WorkerApi>(worker);
  }
  return proxy;
}

export async function generate(req: GenerateRequest): Promise<GenerateResult> {
  return getProxy().generate(req);
}
