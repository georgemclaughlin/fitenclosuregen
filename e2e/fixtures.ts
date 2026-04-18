import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Candidate sample model paths. Tests skip gracefully if none exist locally,
 * so CI doesn't fail on machines without downloaded boards.
 */
const CANDIDATES: Record<string, string[]> = {
  step: [
    path.join(homedir(), "Downloads/T-Display.step"),
    path.join(homedir(), "Downloads/ttgo-t-display-2.snapshot.4/ttgo-t-display.step"),
    path.join(homedir(), "Downloads/seeed-studio-xiao-nrf52840-3d-model/XIAO-nRF52840 v15.step"),
    path.join(homedir(), "Downloads/t-display-s3-full.stp"),
  ],
  stl: [
    path.join(homedir(), "Downloads/XIAO-nRF52840.stl"),
  ],
  obj: [],
  "3mf": [],
};

export function findFixture(kind: keyof typeof CANDIDATES): string | null {
  for (const p of CANDIDATES[kind]) if (existsSync(p)) return p;
  return null;
}
