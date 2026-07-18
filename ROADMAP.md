# Roadmap

The reliability, test isolation, dependency, initial-load, project persistence, and undo/redo work identified in the July 2026 review is implemented. The items below are intentionally deferred to the next product and maintainability phase.

## Product features

1. Mounting and retention
   - PCB standoffs and screw bosses.
   - Heat-set insert holes and configurable lid screws.
   - Retention clips and simple component straps.

2. Direct viewport editing
   - Select and transform items in 3D.
   - Place cutouts by clicking a shell face and resize them with handles.
   - Show face-local dimensions and snap cutouts to imported connector bounds.

3. Manufacturability checks
   - Warn about thin remaining walls, cutout/lip collisions, insufficient snap skin, trapped components, and invalid dimensions.
   - Optionally compare the combined layout against a configured printer bed.

4. Richer export
   - Export 3MF with named base and lid objects and project metadata.
   - Include a compact dimensions and print-orientation report.

## Maintainability

1. Split `src/cad/worker.ts` by responsibility: item cavities, flush relief, connection routing, shell booleans, and result conversion.
2. Split `src/ui/Sidebar.tsx` into section and editor components with shared form primitives.
3. Move connection routing shared by the worker and viewer into one tested module so the preview cannot diverge from the carved corridor.
4. Move inline style constants toward component-scoped CSS and establish a small set of spacing, color, and control tokens.
5. Add focused tests for project serialization, history coalescing, numeric validation, and route parity as those features land.
6. Plan the coordinated React Three Fiber/Drei/Three.js major upgrade; this will also remove Drei 9's deprecated `three-mesh-bvh` transitive version.

## UI and accessibility polish

1. Validate and clamp dimensions, radii, clearances, cutout sizes, and connection sizes before they reach CSG.
2. Add accessible names to icon-only remove/collapse controls and `aria-expanded`/`aria-controls` to collapsible sections.
3. Improve keyboard operation and visible focus states for item, cutout, connection, and numeric controls.
4. Add inline validation messages instead of surfacing preventable parameter errors only in the global status strip.
5. Improve narrow-screen editing with a resizable or collapsible viewer/sidebar split.
