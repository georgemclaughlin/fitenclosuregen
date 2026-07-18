import { useEffect, useRef, useState } from "react";
import { encodeProject, projectFilename, readProjectFile } from "../project/format";
import { captureProjectSnapshot, useStore } from "../state/store";

export function ProjectControls() {
  const projectName = useStore((state) => state.projectName);
  const setProjectName = useStore((state) => state.setProjectName);
  const items = useStore((state) => state.items);
  const cutouts = useStore((state) => state.cutouts);
  const connections = useStore((state) => state.connections);
  const newProject = useStore((state) => state.newProject);
  const loadProject = useStore((state) => state.loadProject);
  const undo = useStore((state) => state.undo);
  const redo = useStore((state) => state.redo);
  const canUndo = useStore((state) => state.canUndo);
  const canRedo = useStore((state) => state.canRedo);
  const setError = useStore((state) => state.setError);
  const fileRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState("Autosaves locally");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select") || target?.isContentEditable) return;
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (key === "y") {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [redo, undo]);

  const save = () => {
    try {
      const bytes = encodeProject(captureProjectSnapshot(useStore.getState()));
      const blob = new Blob([bytes.slice().buffer], { type: "application/vnd.dropfit.project+zip" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = projectFilename(projectName);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus("Project saved");
    } catch (error) {
      setError(`Project save failed: ${(error as Error).message}`);
    }
  };

  const open = async (file: File) => {
    setBusy(true);
    setError(null);
    setStatus(`Opening ${file.name}…`);
    try {
      const snapshot = await readProjectFile(file);
      loadProject(snapshot);
      setStatus(`Opened ${file.name}`);
    } catch (error) {
      setError(`Project open failed: ${(error as Error).message}`);
      setStatus("Open failed");
    } finally {
      setBusy(false);
    }
  };

  const startNew = () => {
    const hasContent = items.length > 0 || cutouts.length > 0 || connections.length > 0;
    if (hasContent && !window.confirm("Start a new project? The current project remains available through Undo and autosave.")) {
      return;
    }
    newProject();
    setStatus("New project");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      <input
        aria-label="Project name"
        value={projectName}
        maxLength={120}
        onChange={(event) => setProjectName(event.target.value)}
        style={nameStyle}
      />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4 }}>
        <button type="button" style={buttonStyle} onClick={startNew}>New</button>
        <button type="button" style={buttonStyle} disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? "Opening…" : "Open…"}
        </button>
        <button type="button" style={buttonStyle} onClick={save}>Save</button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".dropfit,application/zip,application/octet-stream"
        style={{ display: "none" }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void open(file);
          event.target.value = "";
        }}
      />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
        <button type="button" style={buttonStyle} disabled={!canUndo} onClick={undo}>Undo</button>
        <button type="button" style={buttonStyle} disabled={!canRedo} onClick={redo}>Redo</button>
      </div>
      <div role="status" style={{ color: "#8f877a", fontSize: 10 }}>{status}</div>
    </div>
  );
}

const nameStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "#111",
  color: "#eee",
  border: "1px solid #3c352c",
  borderRadius: 5,
  padding: "7px 8px",
  fontSize: 12,
};

const buttonStyle: React.CSSProperties = {
  background: "#34302a",
  color: "#eee",
  border: "1px solid #4a4237",
  borderRadius: 4,
  padding: "6px 8px",
  cursor: "pointer",
  fontSize: 11,
};
