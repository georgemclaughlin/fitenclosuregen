import { useCallback, useState } from "react";
import { loadComponent } from "../io/loaders";
import { useStore } from "../state/store";

export function FileDrop() {
  const addImport = useStore((s) => s.addImport);
  const setError = useStore((s) => s.setError);
  const [hover, setHover] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleFile = useCallback(async (file: File) => {
    setLoading(true);
    setError(null);
    try {
      const loaded = await loadComponent(file);
      addImport(loaded.name, loaded.mesh);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [addImport, setError]);

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setHover(true); }}
      onDragLeave={() => setHover(false)}
      onDrop={(e) => {
        e.preventDefault();
        setHover(false);
        const file = e.dataTransfer.files[0];
        if (file) void handleFile(file);
      }}
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: hover ? "rgba(80,140,220,0.2)" : "rgba(0,0,0,0.5)",
        border: hover ? "3px dashed #58f" : "3px dashed #444",
        margin: 24,
        borderRadius: 12,
        pointerEvents: "auto",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ fontSize: 20 }}>
        {loading ? "Loading…" : "Drop a model file (.stl, .obj, .3mf, .step)"}
      </div>
      <label style={{ padding: "8px 16px", background: "#2a6", borderRadius: 6, cursor: "pointer" }}>
        Or browse
        <input
          type="file"
          accept=".stl,.obj,.3mf,.step,.stp"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
          }}
        />
      </label>
    </div>
  );
}
