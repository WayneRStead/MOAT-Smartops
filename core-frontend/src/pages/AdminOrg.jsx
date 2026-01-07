// src/pages/AdminOrg.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "../ThemeContext";
import { ALL_WIDGETS, normalizeWidgets } from "../widgets/registry";
import { api, fileUrl } from "../lib/api";

/* ---------------- Single source of truth for known modules ---------------- */
const ALL_MODULES = [
  "projects",
  "users",
  "clockings",
  "assets",
  "vehicles",
  "invoices",
  "inspections",
  "vault",
  "tasks",
];

// Map canonical -> server legacy (expand as needed)
const CANON_TO_SERVER = {
  namesList: "namesList", // <- important: send legacy id if backend expects "people"
};
// Accept any legacy value from server -> canonical
const SERVER_TO_CANON = { nameslist: "namesList" };
const toCanon = (id) =>
  SERVER_TO_CANON[String(id || "").toLowerCase()] || String(id || "").toLowerCase();

/* ---- localStorage fallback so widget selection sticks even if backend ignores it ---- */
const WKEY = "org.dashboardWidgets";
const loadWidgetsLocal = () => {
  try {
    return JSON.parse(localStorage.getItem(WKEY) || "[]");
  } catch {
    return [];
  }
};
const saveWidgetsLocal = (arr) => {
  try {
    localStorage.setItem(WKEY, JSON.stringify(arr || []));
  } catch {}
};

/* ----------------- Normalizers (back/compat with old shapes) -------------- */
function normalizeModules(input) {
  if (Array.isArray(input)) return input.filter((k) => ALL_MODULES.includes(k));
  const obj = input && typeof input === "object" ? input : {};
  return ALL_MODULES.filter((k) => !!obj[k]);
}

/* -------------------- Small A11y live announcer -------------------- */
function useLiveAnnouncer() {
  const [msg, setMsg] = useState("");
  const announce = (text) => {
    setMsg("");
    setTimeout(() => setMsg(text), 10);
  };
  const node = (
    <div
      aria-live="polite"
      aria-atomic="true"
      className="sr-only"
      style={{ position: "absolute", left: -9999, top: "auto", width: 1, height: 1, overflow: "hidden" }}
    >
      {msg}
    </div>
  );
  return { announce, node };
}

/* --------- Reorderable Widget Pill --------- */
function WidgetPill({ id, title, enabled, onToggle, onMove }) {
  const [visible, setVisible] = useState(false);
  const lingerTimer = useRef(null);
  const showArrows = () => {
    if (!enabled) return;
    setVisible(true);
    if (lingerTimer.current) clearTimeout(lingerTimer.current);
  };
  const hideArrowsSoon = () => {
    if (!enabled) return;
    if (lingerTimer.current) clearTimeout(lingerTimer.current);
    lingerTimer.current = setTimeout(() => setVisible(false), 50);
  };
  const hideArrowsNow = () => {
    if (lingerTimer.current) clearTimeout(lingerTimer.current);
    setVisible(false);
  };
  const onKeyDown = (e) => {
    if (!enabled) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      onMove(id, -1);
      showArrows();
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      onMove(id, +1);
      showArrows();
    }
  };
  const pillCls = `pill ${enabled ? "active" : ""}`;
  return (
    <div
      className="pill-wrap"
      onMouseEnter={showArrows}
      onMouseLeave={hideArrowsSoon}
      onFocus={showArrows}
      onBlur={hideArrowsSoon}
      tabIndex={-1}
    >
      {enabled && (
        <button
          type="button"
          className={`pill-arrow pill-arrow-left ${visible ? "show" : ""}`}
          aria-label={`Move ${title} left`}
          onClick={() => {
            onMove(id, -1);
            showArrows();
          }}
        >
          ◀
        </button>
      )}
      <button
        type="button"
        className={pillCls}
        onClick={() => {
          onToggle(id);
          hideArrowsNow();
        }}
        title={enabled ? "Enabled — click to disable" : "Disabled — click to enable"}
        onKeyDown={onKeyDown}
        onMouseEnter={showArrows}
        onMouseLeave={hideArrowsSoon}
        onFocus={showArrows}
        onBlur={hideArrowsSoon}
      >
        {title}
      </button>
      {enabled && (
        <button
          type="button"
          className={`pill-arrow pill-arrow-right ${visible ? "show" : ""}`}
          aria-label={`Move ${title} right`}
          onClick={() => {
            onMove(id, +1);
            showArrows();
          }}
        >
          ▶
        </button>
      )}
    </div>
  );
}

/* --------------------- tiny storage helpers --------------------- */
const getOrgId = () => {
  try {
    return (
      localStorage.getItem("currentOrgId") ||
      sessionStorage.getItem("currentOrgId") ||
      localStorage.getItem("orgId") ||
      sessionStorage.getItem("orgId") ||
      localStorage.getItem("tenantId") ||
      sessionStorage.getItem("tenantId") ||
      null
    );
  } catch {
    return null;
  }
};

/* ------------------------------- Component ------------------------------ */
export default function AdminOrg() {
  const { org, setOrg } = useTheme();

  const [loading, setLoading] = useState(!org);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");

  const [name, setName] = useState(org?.name || "");
  const [themeMode, setThemeMode] = useState(org?.themeMode || org?.theme?.mode || "system");
  const [accentColor, setAccentColor] = useState(org?.accentColor || org?.theme?.color || "#2a7fff");

  function initialModulesFrom(orgModules) {
    if (orgModules === undefined || orgModules === null) return ALL_MODULES; // brand-new org
    return normalizeModules(orgModules); // respect empty selection
  }
  const [modules, setModules] = useState(initialModulesFrom(org?.modules));

  // canonical widget ids
  const defaultWidgets = ["health.master", "roles", "namesList", "clockings.today", "projects.all", "tasks.all", "groups"];
  const initialWidgets = (() => {
    const serverRaw = Array.isArray(org?.dashboardWidgets) ? org.dashboardWidgets : [];
    const fromServer = normalizeWidgets(serverRaw.map(toCanon));
    if (fromServer.length) return fromServer;
    const lsRaw = loadWidgetsLocal();
    const fromLS = normalizeWidgets((Array.isArray(lsRaw) ? lsRaw : []).map(toCanon));
    return fromLS.length ? fromLS : defaultWidgets;
  })();
  const [widgets, setWidgets] = useState(initialWidgets);

  const [presets, setPresets] = useState(Array.isArray(org?.taskPresets) ? org.taskPresets : []);
  const [logoFile, setLogoFile] = useState(null);
  const [logoPreview, setLogoPreview] = useState("");
  const [logoBroken, setLogoBroken] = useState(false);

  const savingRef = useRef(false);
  const { announce, node: liveRegion } = useLiveAnnouncer();

  /* ----------------------------- API helpers (scoped) ---------------------------- */
  function orgHeaders() {
    const oid = getOrgId();
    return oid ? { "x-org-id": oid } : {};
  }
  async function apiGetOrg() {
    const { data } = await api.get("/org", { headers: orgHeaders() });
    return data;
  }
  async function apiUpdateOrg(payload) {
    const { data } = await api.put("/org", payload, { headers: orgHeaders() });
    return data;
  }
  async function apiUploadLogo(file) {
    const fd = new FormData();
    fd.append("logo", file);
    const { data } = await api.post("/org/logo", fd, { headers: { ...orgHeaders() } });
    return data;
  }

  /* ----------------------------- initial load ---------------------------- */
  useEffect(() => {
    if (org) {
      setLoading(false);
      return;
    }
    (async () => {
      try {
        if (!getOrgId()) {
          setErr('No org selected. Please sign in (or pick an org) so requests include header "x-org-id".');
          setLoading(false);
          return;
        }
        const data = await apiGetOrg();
        setOrg(data);
        setName(data?.name || "");
        setThemeMode(data?.themeMode || data?.theme?.mode || "system");
        setAccentColor(data?.accentColor || data?.theme?.color || "#2a7fff");
        setModules(initialModulesFrom(data?.modules));

        const serverW = normalizeWidgets((data?.dashboardWidgets || []).map(toCanon));
        const storedW = loadWidgetsLocal();
        setWidgets(serverW.length ? serverW : storedW.length ? storedW : defaultWidgets);

        setPresets(Array.isArray(data?.taskPresets) ? data.taskPresets : []);
      } catch (e) {
        setErr(e?.response?.data?.error || String(e));
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ----------------------- sync with org context changes ------------------ */
  useEffect(() => {
    if (!org) return;
    if (savingRef.current) return;
    setName(org?.name || "");
    setThemeMode(org?.themeMode || org?.theme?.mode || "system");
    setAccentColor(org?.accentColor || org?.theme?.color || "#2a7fff");
    setModules(initialModulesFrom(org?.modules));

    const serverW = normalizeWidgets((org?.dashboardWidgets || []).map(toCanon));
    if (serverW.length) setWidgets(serverW);
    setPresets(Array.isArray(org?.taskPresets) ? org.taskPresets : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org]);

  /* ------------------------------- handlers ------------------------------ */
  function toggleModule(key) {
    setModules((prev) => {
      const s = new Set(prev);
      s.has(key) ? s.delete(key) : s.add(key);
      return Array.from(s);
    });
  }
  function setAllModules(on) {
    setModules(on ? [...ALL_MODULES] : []);
  }

  // Widgets: toggle + ordering
  function toggleWidget(id) {
    setWidgets((prev) => {
      const s = new Set(prev);
      if (s.has(id)) {
        const next = prev.filter((x) => x !== id);
        saveWidgetsLocal(next);
        return next;
      }
      const next = [...prev, id];
      saveWidgetsLocal(next);
      return next;
    });
  }
  function moveWidget(id, dir = -1) {
    setWidgets((prev) => {
      const i = prev.indexOf(id);
      if (i < 0) return prev;
      const j = Math.max(0, Math.min(prev.length - 1, i + dir));
      if (i === j) return prev;
      const next = prev.slice();
      const [item] = next.splice(i, 1);
      next.splice(j, 0, item);
      saveWidgetsLocal(next);
      const title = ALL_WIDGETS.find((w) => w.id === id)?.title || id;
      announce(`Moved “${title}” ${dir < 0 ? "left" : "right"}.`);
      return next;
    });
  }

  // Task Presets
  function addPreset() {
    setPresets((prev) => [
      ...prev,
      { label: "New", title: "New task", tags: [], priority: "medium", defaultStatus: "todo", estimatedMins: 0 },
    ]);
  }
  function updatePreset(i, patch) {
    setPresets((prev) => prev.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  }
  function removePreset(i) {
    setPresets((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function saveOrg(e) {
    e?.preventDefault?.();
    setErr("");
    setInfo("");
    try {
      if (!getOrgId()) {
        setErr('No org selected. Include header "x-org-id" (sign in again or pick an org).');
        return;
      }
      savingRef.current = true;

      // Encode canonical -> server ids before saving
      const widgetsToSave = widgets.map((id) => CANON_TO_SERVER[id] || id);

      const payload = {
        ...(name && name.trim() ? { name: name.trim() } : {}),
        themeMode,
        accentColor,
        modules,
        dashboardWidgets: widgetsToSave,
        taskPresets: presets,
      };

      const updated = await apiUpdateOrg(payload);

      setOrg(updated);
      setModules(normalizeModules(updated?.modules));

      const echoedCanon = normalizeWidgets(
        (Array.isArray(updated?.dashboardWidgets) ? updated.dashboardWidgets : []).map(toCanon)
      );
      if (echoedCanon.length) {
        setWidgets(echoedCanon);
        saveWidgetsLocal(echoedCanon);
      } else {
        saveWidgetsLocal(widgets);
      }

      setThemeMode(updated?.themeMode || "system");
      setAccentColor(updated?.accentColor || "#2a7fff");
      setName(updated?.name || "");
      setPresets(Array.isArray(updated?.taskPresets) ? updated.taskPresets : []);
      setInfo("Organisation updated.");
      setTimeout(() => setInfo(""), 1200);
    } catch (e2) {
      setErr(e2?.response?.data?.error || String(e2));
    } finally {
      setTimeout(() => {
        savingRef.current = false;
      }, 100);
    }
  }

  async function uploadLogo() {
    setErr("");
    setInfo("");
    try {
      if (!getOrgId()) {
        setErr('No org selected. Include header "x-org-id" (sign in again or pick an org).');
        return;
      }
      savingRef.current = true;
      if (!logoFile) return setErr("No logo selected.");
      const updated = await apiUploadLogo(logoFile);
      setOrg(updated);
      setLogoFile(null);
      setLogoPreview("");
      setLogoBroken(false);
      setInfo("Logo uploaded.");
      setTimeout(() => setInfo(""), 1200);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    } finally {
      setTimeout(() => {
        savingRef.current = false;
      }, 100);
    }
  }

  // ✅ Resolve logo URL via backend origin (Render), not relative to Vercel
  const currentLogo = useMemo(() => {
    const u = org?.logoUrl;
    if (!u) return "";
    return fileUrl(u); // handles absolute + /files/... paths consistently
  }, [org?.logoUrl]);

  if (loading) return <div className="p-4">Loading…</div>;

  /* ---- UI helpers ---- */
  const themeTabs = ["system", "light", "dark"];
  const pillClass = (on) => `pill ${on ? "active" : ""}`;
  const enabledSet = new Set(widgets);
  const enabledList = widgets.map((id) => ALL_WIDGETS.find((w) => w.id === id)).filter(Boolean);
  const disabledList = ALL_WIDGETS.filter((w) => !enabledSet.has(w.id));

  return (
    <div className="max-w-7xl mx-auto p-4" style={{ "--accent": accentColor, position: "relative" }}>
      {liveRegion}
      <style>{`
        .label-title{ font-weight:700; font-size:0.95rem; }
        .subtle{ color:#6b7280; }
        .pill{ border:1px solid var(--border,#e5e7eb); padding:.35rem .7rem;border-radius:9999px;cursor:pointer;
               font-weight:600;background:#fff;color:#111827; transition: background .12s ease,border-color .12s ease,color .12s ease;
               white-space:nowrap; position:relative; z-index:1; outline-offset:2px; }
        .pill.active{ background:var(--accent,#111827); border-color:var(--accent,#111827); color:#fff; }
        .pill-wrap{ position:relative; display:inline-flex; align-items:center; gap:.25rem; }
        .pill-arrow{ position:absolute; top:50%; transform:translateY(-50%); opacity:0; pointer-events:none; transition:opacity .12s ease;
                     border:1px solid #e5e7eb; background:#fff; padding:2px 6px; border-radius:6px; height:26px; display:flex; align-items:center; justify-content:center;
                     font-size:12px; line-height:1; z-index:2; }
        .pill-wrap:hover .pill-arrow{ opacity:1; pointer-events:auto; }
        .pill-arrow.show{ opacity:1; pointer-events:auto; }
        .pill-arrow-left{ left:-22px; } .pill-arrow-right{ right:-22px; }
        @media (max-width: 480px){ .pill-arrow-left{ left:-18px; } .pill-arrow-right{ right:-18px; } }
        .btn{ border:1px solid var(--accent,#111827); background:#fff; }
        .btn:hover{ background:var(--accent,#111827); color:#fff; }
        .btn-primary{ background:var(--accent,#111827); border-color:var(--accent,#111827); color:#fff; }
        .btn-primary:hover{ filter:brightness(0.95); }
        .icon-btn{ border:1px solid #e5e7eb; background:#fff; padding:2px 6px; border-radius:6px; }
      `}</style>

      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-semibold">Organization Settings</h1>
        <div className="flex items-center gap-2">
          <button className="btn btn-sm btn-primary" onClick={saveOrg}>
            Save settings
          </button>
        </div>
      </div>

      {/* Missing org guard */}
      {!getOrgId() && (
        <div className="mt-2 text-red-600">
          No organisation selected. Sign in again or pick an org so requests include <code>x-org-id</code>.
        </div>
      )}

      {err && <div className="mt-2 text-red-600">{err}</div>}
      {info && <div className="mt-2 text-green-700">{info}</div>}

      {/* ===== Core settings card ===== */}
      <form onSubmit={saveOrg} className="mt-3 border rounded-xl p-4 space-y-4 bg-white">
        {/* Row: Name | Logo | Theme & Accent */}
        <div className="grid gap-4 md:grid-cols-3">
          <div>
            <div className="label-title">Organization Name</div>
            <input
              className="mt-1 input input-bordered w-full"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. MOAT SmartOps"
            />
          </div>

          <div>
            <div className="label-title">Logo</div>
            <div className="mt-1 flex items-center gap-3 flex-wrap">
              <div
                className="rounded bg-white"
                style={{
                  width: 160,
                  height: 48,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  overflow: "hidden",
                }}
                title="Logo preview"
              >
                {logoPreview ? (
                  <img
                    src={logoPreview}
                    alt="Preview"
                    style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
                  />
                ) : currentLogo && !logoBroken ? (
                  <img
                    src={currentLogo}
                    alt="Current logo"
                    style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
                    onError={() => setLogoBroken(true)}
                  />
                ) : (
                  <span className="text-xs subtle">No logo</span>
                )}
              </div>

              <input
                type="file"
                accept="image/*"
                onChange={(e) => {
                  const f = e.target.files?.[0] || null;
                  setLogoFile(f);
                  setLogoPreview(f ? URL.createObjectURL(f) : "");
                  setLogoBroken(false);
                }}
                title="Choose logo file"
              />

              <button
                className="btn btn-sm"
                onClick={uploadLogo}
                type="button"
                disabled={!logoFile}
                title={!logoFile ? "Choose a file first" : "Upload logo"}
              >
                Upload
              </button>
            </div>

            <div className="text-xs subtle mt-2">Tip: Transparent PNG works well for light/dark themes.</div>
          </div>

          <div>
            <div className="label-title">Appearance</div>
            <div className="mt-2 flex items-center gap-3 flex-wrap">
              <div className="overflow-hidden">
                {themeTabs.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className="px-3 py-2 capitalize"
                    onClick={() => setThemeMode(t)}
                    style={{
                      borderRadius: 6,
                      marginRight: 6,
                      border: "1px solid #e5e7eb",
                      background: themeMode === t ? "var(--accent)" : "#fff",
                      color: themeMode === t ? "#fff" : "#111827",
                      fontWeight: 600,
                    }}
                    title={`Use ${t} theme`}
                  >
                    {t}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2" title="Accent color">
                <input
                  type="color"
                  className="w-10 h-10 p-0 border rounded"
                  value={accentColor}
                  onChange={(e) => setAccentColor(e.target.value)}
                />
                <input
                  className="input input-bordered w-28"
                  value={accentColor}
                  onChange={(e) => setAccentColor(e.target.value)}
                  placeholder="#2a7fff"
                />
              </div>
            </div>
            <div className="text-xs subtle mt-1">
              Tip: This accent color is used for primary buttons, highlights, and links across the app.
            </div>
          </div>
        </div>

        {/* ===== Modules ===== */}
        <div>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="label-title">Modules</div>
            <div className="flex items-center gap-2">
              <button type="button" className="btn btn-sm" onClick={() => setAllModules(true)}>
                Select All
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setAllModules(false)}>
                Clear
              </button>
            </div>
          </div>
          <div className="text-sm subtle mt-1">Select usable org modules.</div>

          <div className="mt-2 flex items-center gap-2 flex-wrap">
            {ALL_MODULES.map((m) => {
              const on = modules.includes(m);
              return (
                <button
                  key={m}
                  type="button"
                  className={pillClass(on)}
                  onClick={() => toggleModule(m)}
                  title={on ? "Enabled" : "Disabled"}
                >
                  {m.replace(/-/g, " ")}
                </button>
              );
            })}
          </div>
        </div>

        {/* ===== Dashboard widgets ===== */}
        <div>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="label-title">Dashboard Widgets</div>
            <div className="text-xs subtle">Toggle and reorder. Tip: focus a pill and use ← → to move.</div>
          </div>

          {/* Enabled (ordered) */}
          <div className="mt-2 flex items-center gap-3 flex-wrap">
            {enabledList.map((w) => (
              <WidgetPill key={w.id} id={w.id} title={w.title} enabled={true} onToggle={toggleWidget} onMove={moveWidget} />
            ))}
          </div>

          {/* Disabled */}
          {disabledList.length > 0 && (
            <>
              <div className="mt-3 text-xs subtle">Available</div>
              <div className="mt-1 flex items-center gap-3 flex-wrap">
                {disabledList.map((w) => (
                  <WidgetPill key={w.id} id={w.id} title={w.title} enabled={false} onToggle={toggleWidget} onMove={() => {}} />
                ))}
              </div>
            </>
          )}
        </div>

        {/* ===== Task presets ===== */}
        <div>
          <div className="flex items-center justify-between gap-3">
            <div className="label-title">Task Presets</div>
            <button type="button" className="btn btn-sm btn-primary" onClick={addPreset}>
              Add preset
            </button>
          </div>

          {!presets.length ? (
            <div className="mt-2 text-sm subtle">No presets yet.</div>
          ) : (
            <div className="mt-2 overflow-x-auto rounded-xl border">
              <table className="table w-full min-w-[1000px]">
                <thead className="bg-gray-50">
                  <tr className="text-xs subtle">
                    <th className="text-left">Button Label</th>
                    <th className="text-left">Default Title</th>
                    <th className="text-left">Priority</th>
                    <th className="text-left">Default Status</th>
                    <th className="text-left">Tags (comma separated)</th>
                    <th className="text-left">Est. Mins</th>
                    <th className="w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {presets.map((p, i) => (
                    <tr key={p._id || i}>
                      <td>
                        <input
                          className="input input-bordered h-9 w-full"
                          value={p.label}
                          onChange={(e) => updatePreset(i, { label: e.target.value })}
                          placeholder="New"
                        />
                      </td>
                      <td>
                        <input
                          className="input input-bordered h-9 w-full"
                          value={p.title}
                          onChange={(e) => updatePreset(i, { title: e.target.value })}
                          placeholder="New task"
                        />
                      </td>
                      <td>
                        <select
                          className="select select-bordered h-9 w-full"
                          value={p.priority || "medium"}
                          onChange={(e) => updatePreset(i, { priority: e.target.value })}
                        >
                          <option>low</option>
                          <option>medium</option>
                          <option>high</option>
                          <option>urgent</option>
                        </select>
                      </td>
                      <td>
                        <select
                          className="select select-bordered h-9 w-full"
                          value={p.defaultStatus || "todo"}
                          onChange={(e) => updatePreset(i, { defaultStatus: e.target.value })}
                        >
                          <option>todo</option>
                          <option>in-progress</option>
                          <option>blocked</option>
                          <option>done</option>
                        </select>
                      </td>
                      <td>
                        <input
                          className="input input-bordered h-9 w-full"
                          value={(p.tags || []).join(", ")}
                          onChange={(e) =>
                            updatePreset(i, {
                              tags: e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
                            })
                          }
                          placeholder="safety, daily"
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          min="0"
                          className="input input-bordered h-9 w-full"
                          value={p.estimatedMins || 0}
                          onChange={(e) => updatePreset(i, { estimatedMins: Number(e.target.value) })}
                        />
                      </td>
                      <td className="text-right">
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => removePreset(i)}
                          title="Remove preset"
                          aria-label="Remove preset"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="pt-2">
          <button className="btn btn-primary">Save settings</button>
        </div>
      </form>
    </div>
  );
}
