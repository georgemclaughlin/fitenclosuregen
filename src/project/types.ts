import type { Connection, Cutout, EnclosureParams, Item } from "../cad/types";

export const PROJECT_FORMAT = "dropfit-project";
export const PROJECT_VERSION = 1;

/** Project-defining state. Generated meshes and viewer preferences are derived. */
export interface ProjectSnapshot {
  name: string;
  items: Item[];
  params: EnclosureParams;
  cutouts: Cutout[];
  connections: Connection[];
}

export interface ProjectLoadOptions {
  recordHistory?: boolean;
}
