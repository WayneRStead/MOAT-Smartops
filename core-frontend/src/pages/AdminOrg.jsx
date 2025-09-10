// src/pages/AdminOrg.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { getOrg, updateOrg, uploadOrgLogo } from "../lib/api";
import { useTheme } from "../ThemeContext";

// Single source of truth for known modules
const ALL_MODULES = [
  "projects",
  "users",
  "clockings",
  "assets",
  "vehicles",
  "invoices",
  "inspections",
  "vault",
  "tasks", // make sure Tasks appears
];

// Normalize any shape into an array of enabled module keys
function normalizeModules(input) {
  if (Array.isArray(input)) {
    return input.filter((k) => ALL_MODULES.includes(k));
  }
  const obj = input && typeof input === "object" ? input : {};
  return ALL_MODULES.filter((k) => !!obj[k]);
}

export default function AdminOrg() {
  const { org, setOrg } = useTheme();

  const [loading, setLoading] = useState(!org);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");

  const [name, setName] = useState(org?.name || "");
  const [themeMode, setThemeMode] = useState(org?.themeMode || org?.theme?.mode || "system");
  const [accentColor, setAccentColor] = useState(org?.accentColor || org?.theme?.color || "#2a7fff");
  const [modules, setModules] = useState(normalizeModules(org?.modules) || ALL_MODULES);

  // NEW: Task presets (admin-defined quick buttons for Tasks page)
  const [presets, setPresets] = useState(Array.isArray(org?.taskPresets) ? org.taskPresets : []);

  const [logoFile, setLogoFile] = useState(null);
  const [logoPreview, setLogoPreview] = useState("");

  // prevent effect from clobbering local edits right after we save
  const savingRef = useRef(false);

  // Initial load if org not in context
  useEffect(() => {
    if (org) { setLoading(false); return; }
    (async () => {
      try {
        const data = await getOrg();
        setOrg(data); // put into context
        setName(data?.name || "");
        setThemeMode(data?.themeMode || data?.theme?.mode || "system");
        setAccentColor(data?.accentColor || data?.theme?.color || "#2a7fff");
        setModules(normalizeModules(data?.modules) || ALL_MODULES);
        setPresets(Array.isArray(data?.taskPresets) ? data.taskPresets : []);
      } catch (e) {
        setErr(e?.response?.data?.error || String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep local editable fields in sync when context org changes
  useEffect(() => {
    if (!org) return;
    if (savingRef.current) return; // don't overwrite right after our own save

    setName(org?.name || "");
    setThemeMode(org?.themeMode || org?.theme?.mode || "system");
    setAccentColor(org?.accentColor || org?.theme?.color || "#2a7fff");
    setModules(normalizeModules(org?.modules) || ALL_MODULES);
    setPresets(Array.isArray(org?.taskPresets) ? org.taskPresets : []);
  }, [org]); // only react to real org changes

  function toggleModule(key) {
    setModules((prev) => {
      const s = new Set(prev);
      s.has(key) ? s.delete(key) : s.add(key);
      return Array.from(s);
    });
  }

  // --- Task Presets handlers ---
  function addPreset() {
    setPresets(prev => [
      ...prev,
      { label: "New preset", title: "New task", tags: [], priority: "medium", defaultStatus: "todo", estimatedMins: 0 }
    ]);
  }
  function updatePreset(i, patch) {
    setPresets(prev => prev.map((p,idx)=> idx===i ? { ...p, ...patch } : p));
  }
  function removePreset(i) {
    setPresets(prev => prev.filter((_,idx)=> idx!==i));
  }

  async function saveOrg(e) {
    e?.preventDefault?.();
    setErr(""); setInfo("");
    try {
      savingRef.current = true;

      const updated = await updateOrg({
        name: name?.trim() || "",
        themeMode,
        accentColor,
        modules,               // send array; backend normalizes & returns shape
        taskPresets: presets,  // NEW: send presets
      });

      // Update both context and local form state from server echo
      setOrg(updated);
      setModules(normalizeModules(updated?.modules));
      setThemeMode(updated?.themeMode || "system");
      setAccentColor(updated?.accentColor || "#2a7fff");
      setName(updated?.name || "");
      setPresets(Array.isArray(updated?.taskPresets) ? updated.taskPresets : []);

      setInfo("Organisation updated.");
      setTimeout(() => setInfo(""), 1200);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    } finally {
      // small timeout to let React flush setOrg -> org effect before re-enabling sync
      setTimeout(() => { savingRef.current = false; }, 100);
    }
  }

  async function uploadLogo() {
    setErr(""); setInfo("");
    try {
      savingRef.current = true;

      if (!logoFile) return setErr("No logo selected.");
      const updated = await uploadOrgLogo(logoFile);

      setOrg(updated);
      setLogoFile(null);
      setLogoPreview("");
      setInfo("Logo uploaded.");
      setTimeout(() => setInfo(""), 1200);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    } finally {
      setTimeout(() => { savingRef.current = false; }, 100);
    }
  }

  // Resolve logo URL
  const currentLogo = useMemo(() => {
    const u = org?.logoUrl;
    if (!u) return "";
    if (u.startsWith("http")) return u;
    if (u.startsWith("/")) return u;
    return `/files/${u}`;
  }, [org?.logoUrl]);

  if (loading) return <div className="p-4">Loading…</div>;

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-xl font-semibold">Admin: Org</h1>
      {err && <div className="text-red-600">{err}</div>}
      {info && <div className="text-green-700">{info}</div>}

      <form onSubmit={saveOrg} className="grid md:grid-cols-2 gap-4 border rounded p-3">
        <label className="text-sm">Organisation Name
          <input className="border p-2 w-full" value={name} onChange={e => setName(e.target.value)} />
        </label>

        <label className="text-sm">Theme
          <select className="border p-2 w-full" value={themeMode} onChange={e => setThemeMode(e.target.value)}>
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>

        <label className="text-sm">Accent Color
          <input className="border p-2 w-full" type="color" value={accentColor} onChange={e => setAccentColor(e.target.value)} />
        </label>

        <div className="md:col-span-2">
          <div className="font-semibold mb-2">Modules</div>
          <div className="grid md:grid-cols-3 gap-2">
            {ALL_MODULES.map((m) => (
              <label key={m} className="flex items-center gap-2 border rounded p-2">
                <input
                  type="checkbox"
                  checked={modules.includes(m)}
                  onChange={() => toggleModule(m)}
                />
                <span className="capitalize">{m}</span>
              </label>
            ))}
          </div>
        </div>

        {/* NEW: Task presets editor */}
        <div className="md:col-span-2 border rounded p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="font-semibold">Task Presets</div>
            <button type="button" className="px-2 py-1 border rounded" onClick={addPreset}>Add preset</button>
          </div>

          {!presets.length && <div className="text-sm text-gray-600">No presets yet.</div>}
          {presets.map((p, i) => (
            <div key={p._id || i} className="grid md:grid-cols-6 gap-2 border rounded p-2">
              <label className="text-sm">Button label
                <input className="border p-2 w-full" value={p.label} onChange={e=>updatePreset(i,{label:e.target.value})} />
              </label>
              <label className="text-sm md:col-span-2">Default title
                <input className="border p-2 w-full" value={p.title} onChange={e=>updatePreset(i,{title:e.target.value})} />
              </label>
              <label className="text-sm">Priority
                <select className="border p-2 w-full" value={p.priority || "medium"} onChange={e=>updatePreset(i,{priority:e.target.value})}>
                  <option>low</option><option>medium</option><option>high</option><option>urgent</option>
                </select>
              </label>
              <label className="text-sm">Default status
                <select className="border p-2 w-full" value={p.defaultStatus || "todo"} onChange={e=>updatePreset(i,{defaultStatus:e.target.value})}>
                  <option>todo</option><option>in-progress</option><option>blocked</option><option>done</option>
                </select>
              </label>
              <label className="text-sm">Tags (comma)
                <input
                  className="border p-2 w-full"
                  value={(p.tags||[]).join(", ")}
                  onChange={e=>updatePreset(i,{
                    tags: e.target.value.split(",").map(s=>s.trim()).filter(Boolean)
                  })}
                />
              </label>
              <label className="text-sm">Est. mins
                <input className="border p-2 w-full" type="number" min="0"
                       value={p.estimatedMins || 0}
                       onChange={e=>updatePreset(i,{estimatedMins:Number(e.target.value)})} />
              </label>
              <div className="md:col-span-6 text-right">
                <button type="button" className="px-2 py-1 border rounded" onClick={()=>removePreset(i)}>Remove</button>
              </div>
            </div>
          ))}
        </div>

        <div className="md:col-span-2">
          <button className="px-3 py-2 bg-black text-white rounded">Save settings</button>
        </div>
      </form>

      {/* Logo upload */}
      <div className="border rounded p-3 space-y-3">
        <div className="font-semibold">Logo</div>
        <div className="flex items-center gap-4">
          <div
            className="border rounded bg-white"
            style={{
              width: 180,
              height: 60,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
            }}
          >
            {logoPreview ? (
              <img
                src={logoPreview}
                alt="Preview"
                style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
              />
            ) : currentLogo ? (
              <img
                src={currentLogo}
                alt="Current logo"
                style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
                onError={(e) => (e.currentTarget.style.display = "none")}
              />
            ) : (
              <span className="text-xs text-gray-500">No logo</span>
            )}
          </div>

          <input
            type="file"
            accept="image/*"
            onChange={(e) => {
              const f = e.target.files?.[0] || null;
              setLogoFile(f);
              setLogoPreview(f ? URL.createObjectURL(f) : "");
            }}
          />
          <button
            className="px-3 py-2 border rounded"
            onClick={uploadLogo}
            type="button"
            disabled={!logoFile}
            title={!logoFile ? "Choose a file first" : "Upload logo"}
          >
            Upload logo
          </button>
        </div>
        <div className="text-xs text-gray-600">Tip: Transparent PNG looks best across light/dark themes.</div>
      </div>
    </div>
  );
}
