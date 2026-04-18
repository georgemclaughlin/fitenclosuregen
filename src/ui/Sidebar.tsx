import { useMemo, useRef, useState } from "react";
import { stackItemRelativePosition } from "../cad/layout";
import { overlappingItemIds, useStore } from "../state/store";
import type { Cutout, EnclosureParams, FaceAxis, Item, Primitive, Vec3 } from "../cad/types";
import { combineForPrint, downloadStl } from "../io/exporters";
import { BATTERY_PRESETS, PRIMITIVE_DEFAULTS, primitiveSize } from "../cad/presets";
import { loadComponent } from "../io/loaders";

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
  { key: "snapSize", label: "Snap bead (mm)", min: 0.1, max: 0.8, step: 0.05 },
];

const FACES: FaceAxis[] = ["+x", "-x", "+y", "-y", "+z", "-z"];

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
  const result = useStore((s) => s.result);
  const generating = useStore((s) => s.generating);
  const error = useStore((s) => s.error);
  const showBase = useStore((s) => s.showBase);
  const showLid = useStore((s) => s.showLid);
  const showComponent = useStore((s) => s.showComponent);
  const shellOpacity = useStore((s) => s.shellOpacity);
  const setVisibility = useStore((s) => s.setVisibility);
  const setShellOpacity = useStore((s) => s.setShellOpacity);

  return (
    <div style={{
      padding: 16, background: "#1a1a1a", overflowY: "auto", borderLeft: "1px solid #333",
      display: "flex", flexDirection: "column", gap: 16,
    }}>
      <h2 style={{ margin: 0, fontSize: 18 }}>FitEnclosureGen</h2>

      <Section title="Items">
        <AddControls
          onImport={(name, mesh) => addImport(name, mesh)}
          onPrimitive={(name, p) => addPrimitive(name, p)}
        />
        {items.length === 0 && <div style={{ color: "#888", fontSize: 12 }}>No items yet.</div>}
        <ItemList />
      </Section>

      <Section title="Parameters">
        {paramDefs.map((d) => (
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
      </Section>

      <Section title="Cutouts">
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
            <NumField label="u" value={c.u} onChange={(v) => updateCutout(c.id, { u: v })} />
            <NumField label="v" value={c.v} onChange={(v) => updateCutout(c.id, { v: v })} />
            <NumField label="w" value={c.w} onChange={(v) => updateCutout(c.id, { w: v })} />
            <NumField label="h" value={c.h} onChange={(v) => updateCutout(c.id, { h: v })} />
          </div>
        ))}
      </Section>

      <Section title="Visibility">
        <Checkbox label="Base" checked={showBase} onChange={(v) => setVisibility("showBase", v)} />
        <Checkbox label="Lid" checked={showLid} onChange={(v) => setVisibility("showLid", v)} />
        <Checkbox label="Component" checked={showComponent} onChange={(v) => setVisibility("showComponent", v)} />
        <Slider label="Shell opacity" value={shellOpacity} min={0.05} max={1} step={0.05} onChange={setShellOpacity} />
      </Section>

      <Section title="Export">
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
      </Section>

      <div style={{ fontSize: 12, color: generating ? "#ad5" : error ? "#e66" : "#888" }}>
        {error ? `Error: ${error}` : generating ? "Generating…" : result ? "Ready." : "Idle."}
      </div>
    </div>
  );
}

function AddControls({ onImport, onPrimitive }: {
  onImport: (name: string, mesh: import("../cad/types").ImportedMesh) => void;
  onPrimitive: (name: string, p: Primitive) => void;
}) {
  const setError = useStore((s) => s.setError);
  const fileRef = useRef<HTMLInputElement>(null);
  const [presetIdx, setPresetIdx] = useState(0);

  const handleFile = async (f: File) => {
    try {
      const loaded = await loadComponent(f);
      onImport(loaded.name, loaded.mesh);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
        <button style={btn} onClick={() => fileRef.current?.click()}>+ Import…</button>
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
          {item.kind === "primitive" && <PrimitiveEditor item={item} onChange={(p) => setPrimitive(item.id, p)} />}
          {item.kind === "import" && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4 }}>
              <button style={smallBtn} onClick={() => flipImportItem(item.id, 0)}>Flip X</button>
              <button style={smallBtn} onClick={() => flipImportItem(item.id, 1)}>Flip Y</button>
              <button style={smallBtn} onClick={() => flipImportItem(item.id, 2)}>Flip Z</button>
            </div>
          )}
          <div style={{ fontSize: 11, color: "#888" }}>Position (mm)</div>
          <NumField label="x" value={item.position[0]} onChange={(v) => setItemPosition(item.id, [v, item.position[1], item.position[2]])} />
          <NumField label="y" value={item.position[1]} onChange={(v) => setItemPosition(item.id, [item.position[0], v, item.position[2]])} />
          <NumField label="z" value={item.position[2]} onChange={(v) => setItemPosition(item.id, [item.position[0], item.position[1], v])} />
          <div style={{ fontSize: 11, color: "#888" }}>
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
          <div style={{ fontSize: 11, color: "#888" }}>Stack relative to other items:</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4 }}>
            <button style={smallBtn} onClick={() => stackAlong(2, 1)}>Above</button>
            <button style={smallBtn} onClick={() => stackAlong(2, -1)}>Below</button>
            <button style={smallBtn} onClick={() => setItemPosition(item.id, [0, 0, 0])}>Center</button>
            <button style={smallBtn} onClick={() => stackAlong(0, 1)}>+X</button>
            <button style={smallBtn} onClick={() => stackAlong(0, -1)}>-X</button>
            <button style={smallBtn} onClick={() => stackAlong(1, 1)}>+Y</button>
            <button style={smallBtn} onClick={() => stackAlong(1, -1)}>-Y</button>
          </div>
          <div style={{ fontSize: 11, color: "#888" }}>
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
      <NumField label="r" value={p.radius} onChange={(v) => onChange({ ...p, radius: v })} />
      <NumField label="h" value={p.height} onChange={(v) => onChange({ ...p, height: v })} />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1, color: "#888" }}>{title}</div>
      {children}
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
        style={{ gridColumn: "1 / span 2" }}
      />
    </label>
  );
}

function NumField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
      <span style={{ width: 14, color: "#aaa" }}>{label}</span>
      <input
        type="number"
        step={0.5}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ flex: 1, background: "#111", color: "#eee", border: "1px solid #333", padding: "2px 4px" }}
      />
    </label>
  );
}

function Checkbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

const btn: React.CSSProperties = {
  background: "#2a6", color: "white", border: 0, padding: "6px 10px",
  borderRadius: 4, cursor: "pointer", fontSize: 12,
};
const smallBtn: React.CSSProperties = {
  background: "#444", color: "white", border: 0, padding: "4px 6px",
  borderRadius: 4, cursor: "pointer", fontSize: 11,
};
const sel: React.CSSProperties = {
  background: "#111", color: "#eee", border: "1px solid #333", padding: "2px 4px", fontSize: 12,
};
