import { useEffect } from "react";
import { Leva } from "leva";
import { Viewer } from "./ui/Viewer";
import { Sidebar } from "./ui/Sidebar";
import { FileDrop } from "./ui/FileDrop";
import { useStore } from "./state/store";
import { generate } from "./cad/manifoldClient";
import { primitiveAabb } from "./cad/presets";
import type { ItemRequest } from "./cad/types";

export function App() {
  const items = useStore((s) => s.items);
  const params = useStore((s) => s.params);
  const cutouts = useStore((s) => s.cutouts);
  const setResult = useStore((s) => s.setResult);
  const setGenerating = useStore((s) => s.setGenerating);
  const setError = useStore((s) => s.setError);

  useEffect(() => {
    if (items.length === 0) {
      setResult(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      setGenerating(true);
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
          };
        });
        const res = await generate({ items: reqItems, params, cutouts });
        if (!cancelled) setResult(res);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setGenerating(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [items, params, cutouts, setResult, setGenerating, setError]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", height: "100%" }}>
      <div style={{ position: "relative" }}>
        <Viewer />
        {items.length === 0 && <FileDrop />}
      </div>
      <Sidebar />
      <Leva hidden />
    </div>
  );
}
