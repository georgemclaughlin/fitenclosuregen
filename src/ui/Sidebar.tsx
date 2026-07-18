import { useEffect, useMemo, useRef, useState } from "react";
import { itemWorldAabb, stackItemRelativePosition } from "../cad/layout";
import { overlappingItemIds, useStore } from "../state/store";
import type {
  AABB,
  Connection,
  ConnectionEndpoint,
  Cutout,
  EnclosureParams,
  FaceAxis,
  GenerateResult,
  Item,
  Primitive,
  SnapPlacement,
  Vec3,
} from "../cad/types";
import { combineForPrint, downloadStl } from "../io/exporters";
import { BATTERY_PRESETS, PRIMITIVE_DEFAULTS, primitiveAabb, primitiveSize } from "../cad/presets";
import { loadComponent } from "../io/loaders";
import { ProjectControls } from "./ProjectControls";

type NumericParamKey = {
  [K in keyof EnclosureParams]: EnclosureParams[K] extends number ? K : never;
}[keyof EnclosureParams];

const paramDefs: Array<{
  key: NumericParamKey;
  label: string;
  min: number;
  max: number;
  step: number;
}> = [
  { key: "wall", label: "Wall (mm)", min: 0.8, max: 5.0, step: 0.1 },
  { key: "floor", label: "Floor (mm)", min: 0.8, max: 6.0, step: 0.1 },
  { key: "clearance", label: "Clearance (mm)", min: 0.0, max: 3.0, step: 0.1 },
  { key: "fillet", label: "Fillet (mm)", min: 0.0, max: 5.0, step: 0.1 },
  { key: "lidFrac", label: "Lid height (fraction)", min: 0.05, max: 0.6, step: 0.01 },
  { key: "lipDepth", label: "Lip depth (mm)", min: 1.0, max: 8.0, step: 0.1 },
  { key: "lipTol", label: "Lip tolerance (mm)", min: 0.05, max: 0.6, step: 0.01 },
  { key: "snapSize", label: "Snap tab (mm)", min: 0.1, max: 0.8, step: 0.05 },
];

const FACES: FaceAxis[] = ["+x", "-x", "+y", "-y", "+z", "-z"];
const SNAP_PLACEMENTS: Array<{ value: SnapPlacement; label: string }> = [
  { value: "both-y", label: "Both Y sides" },
  { value: "both-x", label: "Both X sides" },
  { value: "+x", label: "+X side" },
  { value: "-x", label: "-X side" },
  { value: "+y", label: "+Y side" },
  { value: "-y", label: "-Y side" },
];

export function Sidebar() {
  const items = useStore((s) => s.items);
  const params = useStore((s) => s.params);
  const setParam = useStore((s) => s.setParam);
  const addImport = useStore((s) => s.addImport);
  const addPrimitive = useStore((s) => s.addPrimitive);
  const cutouts = useStore((s) => s.cutouts);
  const addCutout = useStore((s) => s.addCutout);
  const updateCutout = useStore((s) => s.updateCutout);
  const removeCutout = useStore((s) => s.removeCutout);
  const connections = useStore((s) => s.connections);
  const updateConnection = useStore((s) => s.updateConnection);
  const removeConnection = useStore((s) => s.removeConnection);
  const connectionPick = useStore((s) => s.connectionPick);
  const beginConnectionPick = useStore((s) => s.beginConnectionPick);
  const cancelConnectionPick = useStore((s) => s.cancelConnectionPick);
  const result = useStore((s) => s.result);
  const generating = useStore((s) => s.generating);
  const error = useStore((s) => s.error);
  const showBase = useStore((s) => s.showBase);
  const showLid = useStore((s) => s.showLid);
  const showComponent = useStore((s) => s.showComponent);
  const showDebug = useStore((s) => s.showDebug);
  const showConnections = useStore((s) => s.showConnections);
  const showGrid = useStore((s) => s.showGrid);
  const showShellEdges = useStore((s) => s.showShellEdges);
  const debugVisibility = useStore((s) => s.debugVisibility);
  const shellOpacity = useStore((s) => s.shellOpacity);
  const setVisibility = useStore((s) => s.setVisibility);
  const setDebugVisibility = useStore((s) => s.setDebugVisibility);
  const setShellOpacity = useStore((s) => s.setShellOpacity);
  const [debugSnapshot, setDebugSnapshot] = useState("");
  const [debugCopyStatus, setDebugCopyStatus] = useState("");
  const caseParamKeys = new Set<NumericParamKey>(["wall", "floor", "clearance", "fillet"]);
  const caseParamDefs = paramDefs.filter((d) => caseParamKeys.has(d.key));
  const lidParamDefs = paramDefs.filter((d) => !caseParamKeys.has(d.key));

  return (
    <div className="app-sidebar" style={sidebarStyle}>
      <div style={brandCardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={brandMarkStyle}>DF</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <h2 style={{ margin: 0, fontSize: 19, letterSpacing: -0.3 }}>DropFit Studio</h2>
            <div style={{ fontSize: 11, color: "#a89d8c" }}>Drop-in electronics enclosures</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
          <span style={brandPillStyle}>STL export</span>
          <span style={brandPillStyle}>snap-fit</span>
          <span style={brandPillStyle}>wire routing</span>
        </div>
      </div>

      <Section title="Project" summary="portable + autosaved">
        <ProjectControls />
      </Section>

      <Section title="Items" summary={`${items.length} item${items.length === 1 ? "" : "s"}`}>
        <AddControls
          onImport={(name, mesh) => addImport(name, mesh)}
          onPrimitive={(name, p) => addPrimitive(name, p)}
        />
        {items.length === 0 && <div style={{ color: "#888", fontSize: 12 }}>No items yet.</div>}
        <ItemList />
      </Section>

      <Section title="Case" summary={`${params.wall.toFixed(1)}mm wall, ${params.clearance.toFixed(1)}mm fit`}>
        {caseParamDefs.map((d) => (
          <Slider
            key={d.key}
            label={d.label}
            value={params[d.key]}
            min={d.min}
            max={d.max}
            step={d.step}
            onChange={(v) => setParam(d.key, v)}
          />
        ))}
      </Section>

      <Section title="Lid" summary={params.snapFit ? "snap-fit enabled" : "standard lip"}>
        {lidParamDefs.map((d) => (
          <Slider
            key={d.key}
            label={d.label}
            value={params[d.key]}
            min={d.min}
            max={d.max}
            step={d.step}
            onChange={(v) => setParam(d.key, v)}
          />
        ))}
        <Checkbox label="Snap-fit lid" checked={params.snapFit} onChange={(v) => setParam("snapFit", v)} />
        {params.snapFit && (
          <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ width: 90, color: "#aaa" }}>Snap side</span>
            <select
              value={params.snapPlacement}
              onChange={(e) => setParam("snapPlacement", e.target.value as SnapPlacement)}
              style={{ ...sel, flex: 1 }}
            >
              {SNAP_PLACEMENTS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </label>
        )}
      </Section>

      <Section title="Cutouts" summary={`${cutouts.length} cutout${cutouts.length === 1 ? "" : "s"}`}>
        <button style={btn} onClick={() => {
          const c: Cutout = {
            id: crypto.randomUUID(),
            face: "+x",
            u: 10, v: 5,
            w: 9, h: 4,
            shape: "rect",
          };
          addCutout(c);
        }}>Add cutout</button>
        {cutouts.length === 0 && <div style={{ color: "#888", fontSize: 12 }}>None yet.</div>}
        {cutouts.map((c) => (
          <div key={c.id} style={{ padding: 8, background: "#222", borderRadius: 6, display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <select
                value={c.face}
                onChange={(e) => updateCutout(c.id, { face: e.target.value as FaceAxis })}
                style={sel}
              >
                {FACES.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
              <select
                value={c.shape}
                onChange={(e) => updateCutout(c.id, { shape: e.target.value as Cutout["shape"] })}
                style={sel}
              >
                <option value="rect">rect</option>
                <option value="circle">circle</option>
              </select>
              <button style={{ ...btn, marginLeft: "auto", background: "#833" }} onClick={() => removeCutout(c.id)}>×</button>
            </div>
            <NumField label="u" value={c.u} step={0.1} onChange={(v) => updateCutout(c.id, { u: v })} />
            <NumField label="v" value={c.v} step={0.1} onChange={(v) => updateCutout(c.id, { v: v })} />
            <NumField label="w" value={c.w} step={0.1} onChange={(v) => updateCutout(c.id, { w: v })} />
            <NumField label="h" value={c.h} step={0.1} onChange={(v) => updateCutout(c.id, { h: v })} />
          </div>
        ))}
      </Section>

      <Section
        title="Connections"
        summary={connectionPick.active ? "picking points" : `${connections.length} route${connections.length === 1 ? "" : "s"}`}
      >
        <button
          style={btn}
          disabled={items.length === 0}
          onClick={beginConnectionPick}
        >Add connection</button>
        {connectionPick.active && (
          <div style={{ padding: 8, background: "#17351f", border: "1px solid #2a6", borderRadius: 6, color: "#d7ffd7", fontSize: 12, lineHeight: 1.4 }}>
            {connectionPick.first
              ? `Point 1 set on ${connectionPick.first.itemName}. Click the second model point.`
              : "Click a point on any model to set point 1."}
            <button style={{ ...smallBtn, marginTop: 6, width: "100%" }} onClick={cancelConnectionPick}>Cancel picking</button>
          </div>
        )}
        {items.length === 0 && <div style={{ color: "#888", fontSize: 12 }}>Add an item first.</div>}
        {connections.length === 0 && items.length > 0 && <div style={{ color: "#888", fontSize: 12 }}>None yet.</div>}
        {connections.map((c) => (
          <ConnectionEditor
            key={c.id}
            connection={c}
            items={items}
            onChange={(patch) => updateConnection(c.id, patch)}
            onRemove={() => removeConnection(c.id)}
          />
        ))}
      </Section>

      <Section title="Visibility" summary={`${showBase ? "base " : ""}${showLid ? "lid " : ""}${showComponent ? "parts" : ""}`.trim() || "hidden"}>
        <Checkbox label="Base" checked={showBase} onChange={(v) => setVisibility("showBase", v)} />
        <Checkbox label="Lid" checked={showLid} onChange={(v) => setVisibility("showLid", v)} />
        <Checkbox label="Component" checked={showComponent} onChange={(v) => setVisibility("showComponent", v)} />
        <Checkbox label="Virtual connections" checked={showConnections} onChange={(v) => setVisibility("showConnections", v)} />
        <Checkbox label="Grid" checked={showGrid} onChange={(v) => setVisibility("showGrid", v)} />
        <Checkbox label="Shell outlines" checked={showShellEdges} onChange={(v) => setVisibility("showShellEdges", v)} />
        <Checkbox label="Debug helpers" checked={showDebug} onChange={(v) => setVisibility("showDebug", v)} />
        {showDebug && (
          <>
            <Checkbox label="Fit cavity" checked={debugVisibility.fit} onChange={(v) => setDebugVisibility("fit", v)} />
            <Checkbox label="Access pockets" checked={debugVisibility.access} onChange={(v) => setDebugVisibility("access", v)} />
            <Checkbox label="Front relief" checked={debugVisibility.relief} onChange={(v) => setDebugVisibility("relief", v)} />
            <Checkbox label="Flush cutout" checked={debugVisibility.cutout} onChange={(v) => setDebugVisibility("cutout", v)} />
            <Checkbox label="Connections" checked={debugVisibility.connection} onChange={(v) => setDebugVisibility("connection", v)} />
            <div style={{ fontSize: 11, color: "#888", lineHeight: 1.4 }}>
              Pink = fit cavity, yellow = access pockets, orange = front relief, cyan = flushed wall cutout, green = connections.
            </div>
          </>
        )}
        <Slider label="Shell opacity" value={shellOpacity} min={0.05} max={1} step={0.05} onChange={setShellOpacity} />
      </Section>

      <Section title="Export" summary={result ? "ready" : "waiting"}>
        <button
          style={btn}
          disabled={!result}
          onClick={() => result && downloadStl(result.base, "enclosure-base.stl")}
        >Download base.stl</button>
        <button
          style={btn}
          disabled={!result}
          onClick={() => result && downloadStl(result.lid, "enclosure-lid.stl")}
        >Download lid.stl</button>
        <button
          style={btn}
          disabled={!result}
          onClick={() => result && downloadStl(combineForPrint(result.base, result.lid), "enclosure-combined.stl")}
        >Download combined.stl</button>
        <button
          style={{ ...btn, background: "#365b7a" }}
          onClick={() => {
            const snapshot = buildDebugSnapshot({
              items,
              params,
              cutouts,
              connections,
              result,
              generating,
              error,
              visibility: {
                showBase,
                showLid,
                showComponent,
                showDebug,
                showConnections,
                showGrid,
                showShellEdges,
                debugVisibility,
                shellOpacity,
              },
            });
            setDebugSnapshot(snapshot);
            setDebugCopyStatus("Copying…");
            const copy = navigator.clipboard?.writeText(snapshot);
            if (!copy) {
              setDebugCopyStatus("Clipboard unavailable; select the text below.");
              return;
            }
            void copy
              .then(() => setDebugCopyStatus("Copied debug snapshot."))
              .catch(() => setDebugCopyStatus("Copy failed; select the text below."));
          }}
        >Copy debug snapshot</button>
        {debugCopyStatus && <div style={{ fontSize: 11, color: "#aaa" }}>{debugCopyStatus}</div>}
        {debugSnapshot && (
          <textarea
            aria-label="Debug snapshot"
            readOnly
            value={debugSnapshot}
            rows={6}
            style={{
              width: "100%",
              boxSizing: "border-box",
              resize: "vertical",
              background: "#111",
              color: "#ccc",
              border: "1px solid #333",
              borderRadius: 4,
              padding: 6,
              fontSize: 11,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            }}
          />
        )}
      </Section>

      <div style={{
        ...statusStyle,
        borderColor: error ? "#8b3333" : generating ? "#6b812d" : result ? "#2f6b4a" : "#373737",
        color: error ? "#ffcaca" : generating ? "#dff59a" : result ? "#baf3cf" : "#aaa",
      }}>
        <span style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          background: error ? "#e66" : generating ? "#d6e76f" : result ? "#39d27a" : "#777",
        }} />
        {error ? `Error: ${error}` : generating ? "Generating…" : result ? "Ready." : "Idle."}
      </div>
    </div>
  );
}

function buildDebugSnapshot(input: {
  items: Item[];
  params: EnclosureParams;
  cutouts: Cutout[];
  connections: Connection[];
  result: GenerateResult | null;
  generating: boolean;
  error: string | null;
  visibility: Record<string, unknown>;
}) {
  const round = (n: number) => Number(n.toFixed(4));
  const roundVec = (v: Vec3): Vec3 => [round(v[0]), round(v[1]), round(v[2])];
  const roundAabb = (aabb: AABB) => ({ min: roundVec(aabb.min), max: roundVec(aabb.max) });
  return JSON.stringify({
    app: "FitEnclosureGen",
    capturedAt: new Date().toISOString(),
    status: { generating: input.generating, error: input.error, hasResult: Boolean(input.result) },
    warnings: connectionWarnings(input.connections, input.items),
    params: input.params,
    items: input.items.map((item) => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
      position: roundVec(item.position),
      rotation: roundVec(item.rotation),
      flushFace: item.flushFace ?? null,
      fitClearance: item.fitClearance ?? null,
      localAabb: roundAabb(item.kind === "import" ? item.mesh.aabb : primitiveAabb(item.primitive)),
      worldAabb: roundAabb(itemWorldAabb(item)),
      primitive: item.kind === "primitive" ? item.primitive : undefined,
      import: item.kind === "import"
        ? {
            meshVersion: item.meshVersion ?? 0,
            vertexCount: item.mesh.positions.length / 3,
            triangleCount: item.mesh.indices.length / 3,
            partCount: item.mesh.parts.length,
          }
        : undefined,
    })),
    cutouts: input.cutouts,
    connections: input.connections,
    result: input.result
      ? {
          outer: roundAabb(input.result.outer),
          bodyOuter: roundAabb(input.result.bodyOuter ?? input.result.outer),
          baseTriangles: input.result.base.indices.length / 3,
          lidTriangles: input.result.lid.indices.length / 3,
          debugMeshes: input.result.debug?.map((d) => ({
            key: d.key,
            triangles: d.mesh.indices.length / 3,
          })) ?? [],
        }
      : null,
    visibility: input.visibility,
  }, null, 2);
}

function AddControls({ onImport, onPrimitive }: {
  onImport: (name: string, mesh: import("../cad/types").ImportedMesh) => void;
  onPrimitive: (name: string, p: Primitive) => void;
}) {
  const setError = useStore((s) => s.setError);
  const setImporting = useStore((s) => s.setImporting);
  const fileRef = useRef<HTMLInputElement>(null);
  const [presetIdx, setPresetIdx] = useState(0);
  const [loadingFile, setLoadingFile] = useState<string | null>(null);

  const handleFile = async (f: File) => {
    setLoadingFile(f.name);
    setImporting(`Loading ${f.name}`);
    setError(null);
    try {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const loaded = await loadComponent(f);
      onImport(loaded.name, loaded.mesh);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingFile(null);
      setImporting(null);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
        <button style={btn} disabled={Boolean(loadingFile)} onClick={() => fileRef.current?.click()}>
          {loadingFile ? "Loading…" : "+ Import…"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".stl,.obj,.3mf,.step,.stp"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
            e.target.value = "";
          }}
        />
        <button style={btn} onClick={() => onPrimitive("Box", { ...PRIMITIVE_DEFAULTS.box })}>+ Box</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
        <button style={btn} onClick={() => onPrimitive("Cylinder", { ...PRIMITIVE_DEFAULTS.cylinder })}>+ Cylinder</button>
        <button style={btn} onClick={() => {
          const preset = BATTERY_PRESETS[presetIdx];
          onPrimitive(preset.label, { ...preset.primitive });
        }}>+ Battery</button>
      </div>
      <select
        value={presetIdx}
        onChange={(e) => setPresetIdx(parseInt(e.target.value, 10))}
        style={{ ...sel, width: "100%" }}
      >
        {BATTERY_PRESETS.map((p, i) => (
          <option key={p.label} value={i}>{p.label}</option>
        ))}
      </select>
      {loadingFile && <div style={{ fontSize: 11, color: "#ad5" }}>Parsing {loadingFile}…</div>}
    </div>
  );
}

function ConnectionEditor({ connection, items, onChange, onRemove }: {
  connection: Connection;
  items: Item[];
  onChange: (patch: Partial<Connection>) => void;
  onRemove: () => void;
}) {
  const warnings = connectionWarnings([connection], items);
  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          type="text"
          value={connection.name}
          onChange={(e) => onChange({ name: e.target.value })}
          style={{ flex: 1, ...sel, fontSize: 12 }}
        />
        <button style={{ ...btn, marginLeft: "auto", background: "#833" }} onClick={onRemove}>×</button>
      </div>
      <div style={{ fontSize: 11, color: "#aaa", lineHeight: 1.4 }}>
        A: {endpointSummary(connection.a, items)}<br />
        B: {endpointSummary(connection.b, items)}
      </div>
      {warnings.map((warning) => (
        <div key={warning} style={warningStyle}>{warning}</div>
      ))}
      <details style={detailsStyle}>
        <summary style={summaryStyle}>Advanced endpoints</summary>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
          <EndpointEditor
            label="A"
            endpoint={connection.a}
            items={items}
            onChange={(endpoint) => onChange({ a: endpoint })}
          />
          <EndpointEditor
            label="B"
            endpoint={connection.b}
            items={items}
            onChange={(endpoint) => onChange({ b: endpoint })}
          />
        </div>
      </details>
      <div style={subheadStyle}>Corridor</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
        <select
          value={connection.shape}
          onChange={(e) => onChange({ shape: e.target.value as Connection["shape"] })}
          style={sel}
        >
          <option value="rect">rect</option>
          <option value="round">round</option>
        </select>
      </div>
      <NumField label={connection.shape === "round" ? "diameter" : "width"} value={connection.width} step={0.1} onChange={(v) => onChange({ width: v })} />
      {connection.shape === "rect" && (
        <NumField label="height" value={connection.height} step={0.1} onChange={(v) => onChange({ height: v })} />
      )}
      <NumField label="pad" value={connection.clearance} step={0.1} onChange={(v) => onChange({ clearance: v })} />
    </div>
  );
}

function connectionWarnings(connections: Connection[], items: Item[]) {
  const byId = new Map(items.map((item) => [item.id, item.name]));
  const warnings: string[] = [];
  for (const connection of connections) {
    const endpoints = [
      { label: "A", endpoint: connection.a },
      { label: "B", endpoint: connection.b },
    ];
    for (const { label, endpoint } of endpoints) {
      const itemName = byId.get(endpoint.itemId) ?? "unknown item";
      if (endpoint.face === "-z") {
        warnings.push(`${connection.name} ${label} on ${itemName} uses -Z: underside routes can deepen the base and are not drop-in safe unless intentional.`);
      } else if (endpoint.face === "+z") {
        warnings.push(`${connection.name} ${label} on ${itemName} uses +Z: top routes reserve vertical headspace; prefer a side face when the wire exits sideways.`);
      }
    }
  }
  return warnings;
}

function endpointSummary(endpoint: ConnectionEndpoint, items: Item[]) {
  const item = items.find((it) => it.id === endpoint.itemId);
  return `${item?.name ?? "missing item"} ${endpoint.face} u ${formatNumber(endpoint.u, 3)}, v ${formatNumber(endpoint.v, 3)}`;
}

function EndpointEditor({ label, endpoint, items, onChange }: {
  label: string;
  endpoint: ConnectionEndpoint;
  items: Item[];
  onChange: (endpoint: ConnectionEndpoint) => void;
}) {
  const selected = items.find((it) => it.id === endpoint.itemId) ?? items[0];
  const patch = (p: Partial<ConnectionEndpoint>) => onChange({ ...endpoint, ...p });
  return (
    <div style={{ padding: 6, border: "1px solid #333", borderRadius: 4, display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ color: "#aaa", fontSize: 11 }}>Endpoint {label}</div>
      <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
        <span style={{ width: 44, color: "#aaa" }}>item</span>
        <select
          value={selected?.id ?? ""}
          onChange={(e) => patch({ itemId: e.target.value })}
          style={{ ...sel, flex: 1 }}
        >
          {items.map((it) => <option key={it.id} value={it.id}>{it.name}</option>)}
        </select>
      </label>
      <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
        <span style={{ width: 44, color: "#aaa" }}>face</span>
        <select
          value={endpoint.face}
          onChange={(e) => patch({ face: e.target.value as FaceAxis })}
          style={{ ...sel, flex: 1 }}
        >
          {FACES.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
      </label>
      <NumField label="u" value={endpoint.u} step={0.1} onChange={(v) => patch({ u: v })} />
      <NumField label="v" value={endpoint.v} step={0.1} onChange={(v) => patch({ v })} />
      <NumField label="depth" value={endpoint.depth} step={0.1} onChange={(v) => patch({ depth: v })} />
    </div>
  );
}

function ItemList() {
  const items = useStore((s) => s.items);
  const overlaps = useMemo(() => overlappingItemIds(items), [items]);
  return (
    <>
      {overlaps.size > 0 && (
        <div style={{
          padding: "6px 8px", background: "#4a1f1f", border: "1px solid #833",
          borderRadius: 4, color: "#f99", fontSize: 11,
        }}>
          {overlaps.size} item{overlaps.size > 1 ? "s" : ""} overlap — adjust position or use stack buttons.
        </div>
      )}
      {items.map((it) => <ItemCard key={it.id} item={it} overlapping={overlaps.has(it.id)} />)}
    </>
  );
}

function ItemCard({ item, overlapping }: { item: Item; overlapping: boolean }) {
  const removeItem = useStore((s) => s.removeItem);
  const setItemPosition = useStore((s) => s.setItemPosition);
  const setItemRotation = useStore((s) => s.setItemRotation);
  const renameItem = useStore((s) => s.renameItem);
  const setPrimitive = useStore((s) => s.setPrimitive);
  const setItemFitClearance = useStore((s) => s.setItemFitClearance);
  const flipImportItem = useStore((s) => s.flipImportItem);
  const flushItem = useStore((s) => s.flushItem);
  const unflushItem = useStore((s) => s.unflushItem);
  const items = useStore((s) => s.items);
  const params = useStore((s) => s.params);
  const [expanded, setExpanded] = useState(true);

  const rotateBy = (axis: 0 | 1 | 2, deg: number) => {
    const next: Vec3 = [item.rotation[0], item.rotation[1], item.rotation[2]];
    next[axis] = ((next[axis] + deg) % 360 + 360) % 360;
    setItemRotation(item.id, next);
  };

  const size = item.kind === "import"
    ? [
        item.mesh.aabb.max[0] - item.mesh.aabb.min[0],
        item.mesh.aabb.max[1] - item.mesh.aabb.min[1],
        item.mesh.aabb.max[2] - item.mesh.aabb.min[2],
      ] as Vec3
    : primitiveSize(item.primitive);

  const stackAlong = (axis: 0 | 1 | 2, sign: 1 | -1) => {
    const others = items.filter((o) => o.id !== item.id);
    setItemPosition(item.id, stackItemRelativePosition(item, others, params.clearance, axis, sign));
  };

  return (
    <div style={{
      padding: 8,
      background: "#222",
      borderRadius: 6,
      display: "flex",
      flexDirection: "column",
      gap: 6,
      border: overlapping ? "1px solid #b55" : "1px solid transparent",
    }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          type="text"
          value={item.name}
          onChange={(e) => renameItem(item.id, e.target.value)}
          style={{ flex: 1, ...sel, fontSize: 12 }}
        />
        <button style={smallBtn} onClick={() => setExpanded((v) => !v)}>{expanded ? "–" : "+"}</button>
        <button style={{ ...smallBtn, background: "#833" }} onClick={() => removeItem(item.id)}>×</button>
      </div>
      <div style={{ fontSize: 11, color: "#888" }}>
        {item.kind === "import" ? "imported" : item.primitive.kind}
        {" — "}
        {size.map((v) => v.toFixed(1)).join(" × ")} mm
      </div>
      {expanded && (
        <>
          {item.kind === "primitive" && (
            <>
              <div style={subheadStyle}>Shape</div>
              <PrimitiveEditor item={item} onChange={(p) => setPrimitive(item.id, p)} />
            </>
          )}
          {item.kind === "import" && (
            <>
              <div style={subheadStyle}>Import orientation</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4 }}>
                <button style={smallBtn} onClick={() => flipImportItem(item.id, 0)}>Flip X</button>
                <button style={smallBtn} onClick={() => flipImportItem(item.id, 1)}>Flip Y</button>
                <button style={smallBtn} onClick={() => flipImportItem(item.id, 2)}>Flip Z</button>
              </div>
            </>
          )}
          <div style={subheadStyle}>Position (mm)</div>
          <NumField label="x" value={item.position[0]} onChange={(v) => setItemPosition(item.id, [v, item.position[1], item.position[2]])} />
          <NumField label="y" value={item.position[1]} onChange={(v) => setItemPosition(item.id, [item.position[0], v, item.position[2]])} />
          <NumField label="z" value={item.position[2]} onChange={(v) => setItemPosition(item.id, [item.position[0], item.position[1], v])} />
          <div style={subheadStyle}>Fit clearance override (mm)</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 4, alignItems: "center" }}>
            <NumField
              label="fit"
              value={item.fitClearance ?? params.clearance}
              step={0.1}
              onChange={(v) => setItemFitClearance(item.id, v)}
            />
            <button
              style={smallBtn}
              disabled={item.fitClearance == null}
              onClick={() => setItemFitClearance(item.id, null)}
            >Global</button>
          </div>
          <div style={subheadStyle}>
            Rotation (°): {item.rotation.map((r) => r.toFixed(0)).join(", ")}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 3 }}>
            <button style={smallBtn} onClick={() => rotateBy(0, -90)}>-X</button>
            <button style={smallBtn} onClick={() => rotateBy(0, 90)}>+X</button>
            <button style={smallBtn} onClick={() => rotateBy(1, -90)}>-Y</button>
            <button style={smallBtn} onClick={() => rotateBy(1, 90)}>+Y</button>
            <button style={smallBtn} onClick={() => rotateBy(2, -90)}>-Z</button>
            <button style={smallBtn} onClick={() => rotateBy(2, 90)}>+Z</button>
          </div>
          <button style={smallBtn} onClick={() => setItemRotation(item.id, [0, 0, 0])}>Reset rotation</button>
          <div style={subheadStyle}>Place relative to other items</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4 }}>
            <button style={smallBtn} onClick={() => stackAlong(2, 1)}>Above</button>
            <button style={smallBtn} onClick={() => stackAlong(2, -1)}>Below</button>
            <button style={smallBtn} onClick={() => setItemPosition(item.id, [0, 0, 0])}>Center</button>
            <button style={smallBtn} onClick={() => stackAlong(0, 1)}>+X</button>
            <button style={smallBtn} onClick={() => stackAlong(0, -1)}>-X</button>
            <button style={smallBtn} onClick={() => stackAlong(1, 1)}>+Y</button>
            <button style={smallBtn} onClick={() => stackAlong(1, -1)}>-Y</button>
          </div>
          <div style={subheadStyle}>
            Flush to wall{item.flushFace ? ` (${item.flushFace})` : ""}:
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 3 }}>
            {(["+x", "-x", "+y", "-y"] as const).map((f) => (
              <button
                key={f}
                style={item.flushFace === f ? { ...smallBtn, background: "#a52" } : smallBtn}
                onClick={() => item.flushFace === f ? unflushItem(item.id) : flushItem(item.id, f)}
              >{f}</button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function PrimitiveEditor({ item, onChange }: {
  item: Extract<Item, { kind: "primitive" }>;
  onChange: (p: Primitive) => void;
}) {
  const p = item.primitive;
  if (p.kind === "box") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <NumField label="sx" value={p.size[0]} onChange={(v) => onChange({ ...p, size: [v, p.size[1], p.size[2]] })} />
        <NumField label="sy" value={p.size[1]} onChange={(v) => onChange({ ...p, size: [p.size[0], v, p.size[2]] })} />
        <NumField label="sz" value={p.size[2]} onChange={(v) => onChange({ ...p, size: [p.size[0], p.size[1], v] })} />
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
        <span style={{ width: 36, color: "#aaa" }}>axis</span>
        <select
          value={p.axis}
          onChange={(e) => onChange({ ...p, axis: e.target.value as "x" | "y" | "z" })}
          style={sel}
        >
          <option value="x">X</option>
          <option value="y">Y</option>
          <option value="z">Z</option>
        </select>
      </label>
      <NumField label="r" value={p.radius} step={0.1} onChange={(v) => onChange({ ...p, radius: v })} />
      <NumField label="h" value={p.height} onChange={(v) => onChange({ ...p, height: v })} />
    </div>
  );
}

function Section({ title, summary, defaultOpen = true, children }: {
  title: string;
  summary?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={sectionStyle}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={sectionHeaderStyle}
      >
        <span style={{ color: "#9a8c76", fontSize: 10, width: 12 }}>{open ? "▾" : "▸"}</span>
        <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1.4, color: "#c7bda9" }}>{title}</span>
        {summary && <span style={sectionSummaryStyle}>{summary}</span>}
      </button>
      {open && <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{children}</div>}
    </div>
  );
}

function Slider({ label, value, min, max, step, onChange }: {
  label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void;
}) {
  return (
    <label style={{ fontSize: 12, display: "grid", gridTemplateColumns: "1fr auto", alignItems: "center", gap: 6 }}>
      <span>{label}</span>
      <span style={{ color: "#aaa" }}>{value.toFixed(2)}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ gridColumn: "1 / span 2", accentColor: "#d89445" }}
      />
    </label>
  );
}

function NumField({ label, value, onChange, step = 0.5 }: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
}) {
  const valueRef = useRef(value);
  const holdDelayRef = useRef<number | null>(null);
  const repeatRef = useRef<number | null>(null);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);
  useEffect(() => () => {
    if (holdDelayRef.current !== null) window.clearTimeout(holdDelayRef.current);
    if (repeatRef.current !== null) window.clearInterval(repeatRef.current);
  }, []);
  const bump = (delta: number) => {
    const base = Number.isFinite(valueRef.current) ? valueRef.current : 0;
    const digits = Math.max(0, Math.ceil(-Math.log10(step)));
    const next = Number((base + delta).toFixed(digits + 2));
    valueRef.current = next;
    onChange(next);
  };
  const stopRepeat = () => {
    if (holdDelayRef.current !== null) {
      window.clearTimeout(holdDelayRef.current);
      holdDelayRef.current = null;
    }
    if (repeatRef.current !== null) {
      window.clearInterval(repeatRef.current);
      repeatRef.current = null;
    }
  };
  const startRepeat = (delta: number) => (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    stopRepeat();
    bump(delta);
    holdDelayRef.current = window.setTimeout(() => {
      repeatRef.current = window.setInterval(() => bump(delta), 65);
    }, 350);
  };
  return (
    <label style={{ fontSize: 12, display: "grid", gridTemplateColumns: "24px 28px 1fr 28px", gap: 4, alignItems: "center" }}>
      <span style={{ width: 14, color: "#aaa" }}>{label}</span>
      <button
        type="button"
        style={stepBtn}
        onPointerDown={startRepeat(-step)}
        onPointerUp={stopRepeat}
        onPointerCancel={stopRepeat}
        onLostPointerCapture={stopRepeat}
        onContextMenu={(event) => event.preventDefault()}
        aria-label={`${label} decrease`}
      >−</button>
      <input
        type="number"
        aria-label={label}
        step={step}
        value={Number.isFinite(value) ? formatNumber(value, displayPrecision(step)) : ""}
        onChange={(e) => {
          const next = parseFloat(e.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
        style={{
          minWidth: 0,
          background: "#111",
          color: "#eee",
          border: "1px solid #333",
          borderRadius: 3,
          padding: "5px 6px",
          fontSize: 12,
          appearance: "textfield",
          MozAppearance: "textfield",
        }}
      />
      <button
        type="button"
        style={stepBtn}
        onPointerDown={startRepeat(step)}
        onPointerUp={stopRepeat}
        onPointerCancel={stopRepeat}
        onLostPointerCapture={stopRepeat}
        onContextMenu={(event) => event.preventDefault()}
        aria-label={`${label} increase`}
      >+</button>
    </label>
  );
}

function displayPrecision(step: number) {
  if (!Number.isFinite(step) || step <= 0) return 3;
  return Math.max(2, Math.min(4, Math.ceil(-Math.log10(step)) + 1));
}

function formatNumber(value: number, precision = 3) {
  if (!Number.isFinite(value)) return "";
  if (Math.abs(value) < 10 ** -precision) return "0";
  return Number(value.toFixed(precision)).toString();
}

function Checkbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ accentColor: "#d89445" }} />
      {label}
    </label>
  );
}

const sidebarStyle: React.CSSProperties = {
  padding: 16,
  background: "linear-gradient(180deg, #171716 0%, #121211 100%)",
  overflowY: "auto",
  borderLeft: "1px solid #3b3328",
  boxShadow: "inset 1px 0 0 rgba(255,255,255,0.03)",
  display: "flex",
  flexDirection: "column",
  gap: 12,
};
const brandCardStyle: React.CSSProperties = {
  padding: "13px 12px",
  borderRadius: 12,
  background: "linear-gradient(135deg, rgba(216,148,69,0.16), rgba(62,44,25,0.2))",
  border: "1px solid rgba(216,148,69,0.22)",
};
const brandMarkStyle: React.CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: 10,
  display: "grid",
  placeItems: "center",
  fontSize: 12,
  fontWeight: 800,
  color: "#23160b",
  background: "linear-gradient(135deg, #ffc36b, #d89445)",
  boxShadow: "0 8px 18px rgba(216,148,69,0.18)",
};
const brandPillStyle: React.CSSProperties = {
  border: "1px solid rgba(255,195,107,0.22)",
  borderRadius: 999,
  padding: "3px 7px",
  color: "#d7c8b0",
  background: "rgba(0,0,0,0.18)",
  fontSize: 10,
};
const sectionStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: "10px 10px 12px",
  borderRadius: 10,
  background: "rgba(255,255,255,0.025)",
  border: "1px solid rgba(255,255,255,0.055)",
};
const sectionHeaderStyle: React.CSSProperties = {
  background: "transparent",
  border: 0,
  color: "#ddd",
  padding: 0,
  display: "grid",
  gridTemplateColumns: "auto 1fr auto",
  gap: 6,
  alignItems: "center",
  cursor: "pointer",
  textAlign: "left",
};
const sectionSummaryStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#84796a",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const statusStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 10px",
  borderRadius: 10,
  background: "rgba(18,18,17,0.92)",
  border: "1px solid",
  fontSize: 12,
};
const btn: React.CSSProperties = {
  background: "linear-gradient(180deg, #2fb36f, #22965c)",
  color: "white",
  border: "1px solid rgba(255,255,255,0.08)",
  padding: "7px 10px",
  borderRadius: 7,
  cursor: "pointer",
  fontSize: 12,
  boxShadow: "0 1px 0 rgba(255,255,255,0.08) inset",
};
const smallBtn: React.CSSProperties = {
  background: "#403d38",
  color: "white",
  border: "1px solid rgba(255,255,255,0.08)",
  padding: "4px 6px",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 11,
};
const stepBtn: React.CSSProperties = {
  background: "#34312d",
  color: "#eee",
  border: "1px solid #5c5144",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 16,
  lineHeight: 1,
  minHeight: 28,
  padding: 0,
};
const cardStyle: React.CSSProperties = {
  padding: 8,
  background: "#24211d",
  border: "1px solid rgba(255,255,255,0.05)",
  borderRadius: 8,
  display: "flex",
  flexDirection: "column",
  gap: 6,
};
const subheadStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#888",
  marginTop: 2,
};
const detailsStyle: React.CSSProperties = {
  border: "1px solid #333",
  borderRadius: 4,
  padding: "5px 6px",
};
const summaryStyle: React.CSSProperties = {
  cursor: "pointer",
  color: "#aaa",
  fontSize: 11,
};
const warningStyle: React.CSSProperties = {
  padding: "5px 6px",
  border: "1px solid #7a5b1e",
  borderRadius: 4,
  background: "#2d2412",
  color: "#e7c46a",
  fontSize: 11,
  lineHeight: 1.35,
};
const sel: React.CSSProperties = {
  background: "#111",
  color: "#eee",
  border: "1px solid #3d372f",
  borderRadius: 5,
  padding: "3px 5px",
  fontSize: 12,
};
