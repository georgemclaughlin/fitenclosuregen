# fitenclosuregen

Browser-based enclosure generator for fitting imported parts or simple primitives inside a printable two-part shell.

It is built around a Vite/React UI, a `three.js` preview, and a worker-backed CSG pipeline using `manifold-3d`. The current workflow is aimed at quick fit checks: import a board or part, arrange it, generate a base/lid shell, and export STL files.

## What It Does

- Imports `STL`, `OBJ`, `3MF`, and `STEP` / `STP` models.
- Auto-orients imported geometry to a Z-up workspace.
- Adds simple primitives directly in the UI:
  box, cylinder, and battery presets.
- Generates a split enclosure with:
  wall, floor, clearance, fillet, lid fraction, lip, and optional snap-fit controls.
- Supports manual arrangement tools:
  move, rotate, stack relative to other items, flip imports, and flush selected items to `±X` / `±Y` walls.
- Supports manual face cutouts and STL export for:
  base, lid, or a combined print layout.

## Setup

```bash
npm install
npm run dev
```

Use Node.js 20.19+ or 22.12+.

Open `http://localhost:5173`.

The `predev` and `prebuild` hooks copy the `occt-import-js` assets into `public/occt`, which is required for STEP import.

## Scripts

```bash
npm run dev
npm run build
npm test
npm run e2e
```

## Workflow

1. Add a part with `+ Import…` or create a primitive.
2. Arrange items with position, rotation, stack, flip, or flush controls.
3. Tune enclosure parameters in the sidebar.
4. Add any required cutouts.
5. Export `base.stl`, `lid.stl`, or `combined.stl`.

## Supported Inputs

- `STL`
- `OBJ`
- `3MF`
- `STEP` / `STP`

## Notes

- Enclosure sizing is currently driven by transformed AABBs and per-part hulls, not exact B-rep mating.
- Flush placement is currently exposed in the UI for side walls only: `+x`, `-x`, `+y`, `-y`.
- Playwright generates deterministic STL, OBJ, and 3MF fixtures and uses the OCCT package's small STEP fixture.
- The production bundle is currently large because the app ships CAD and viewer dependencies into the browser.

## Roadmap

Deferred product features and maintainability/UI work are tracked in [ROADMAP.md](./ROADMAP.md).
