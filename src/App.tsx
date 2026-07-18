import { useEffect } from "react";
import { Viewer } from "./ui/Viewer";
import { Sidebar } from "./ui/Sidebar";
import { FileDrop } from "./ui/FileDrop";
import { useStore } from "./state/store";
import { generate, GenerationSupersededError } from "./cad/manifoldClient";
import { primitiveAabb } from "./cad/presets";
import type { ItemRequest } from "./cad/types";

export function App() {
  const items = useStore((s) => s.items);
  const params = useStore((s) => s.params);
  const cutouts = useStore((s) => s.cutouts);
  const connections = useStore((s) => s.connections);
  const setResult = useStore((s) => s.setResult);
  const setGenerating = useStore((s) => s.setGenerating);
  const setError = useStore((s) => s.setError);

  useEffect(() => {
    if (items.length === 0) {
      setResult(null);
      setGenerating(false);
      return;
    }
    setGenerating(true);
    let cancelled = false;
    const t = setTimeout(async () => {
      setError(null);
      try {
        const reqItems: ItemRequest[] = items.map((it) => {
          if (it.kind === "import") {
            return {
              id: it.id,
              kind: "import",
              position: it.position,
              rotation: it.rotation,
              aabb: it.mesh.aabb,
              parts: it.mesh.parts,
              meshVersion: it.meshVersion,
              flushFace: it.flushFace,
              fitClearance: it.fitClearance,
            };
          }
          return {
            id: it.id,
            kind: "primitive",
            position: it.position,
            rotation: it.rotation,
            aabb: primitiveAabb(it.primitive),
            primitive: it.primitive,
            flushFace: it.flushFace,
            fitClearance: it.fitClearance,
          };
        });
        const res = await generate({ items: reqItems, params, cutouts, connections });
        if (!cancelled) setResult(res);
      } catch (e) {
        if (!cancelled && !(e instanceof GenerationSupersededError)) {
          setError((e as Error).message);
        }
      } finally {
        if (!cancelled) setGenerating(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [items, params, cutouts, connections, setResult, setGenerating, setError]);

  return (
    <div className="app-shell">
      <style>{`
        .app-shell {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 340px;
          height: 100%;
          width: 100%;
          overflow: hidden;
        }
        .viewer-pane {
          position: relative;
          min-width: 0;
          min-height: 0;
          overflow: hidden;
        }
        @media (max-width: 760px) {
          .app-shell {
            grid-template-columns: minmax(0, 1fr);
            grid-template-rows: minmax(44vh, 1fr) minmax(250px, 42vh);
          }
          .app-sidebar {
            border-left: 0 !important;
            border-top: 1px solid #3b3328;
            padding: 10px !important;
          }
        }
        @media (max-width: 480px) {
          .app-shell {
            grid-template-rows: minmax(38vh, 1fr) minmax(280px, 48vh);
          }
        }
      `}</style>
      <div className="viewer-pane">
        <Viewer />
        {items.length === 0 && <FileDrop />}
      </div>
      <Sidebar />
    </div>
  );
}
