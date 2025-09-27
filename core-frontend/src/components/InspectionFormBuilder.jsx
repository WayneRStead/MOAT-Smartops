// src/components/InspectionFormBuilder.jsx
import React, { useEffect, useMemo, useState } from "react";
import { api, listProjects, listProjectTasks, listProjects as listProjectsApi } from "../lib/api";

// Fallback roles if the API doesn't expose any
const FALLBACK_ROLES = ["worker", "supervisor", "group_leader", "manager", "admin"];

const NEW_ID = () =>
  (typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `fld_${Math.random().toString(36).slice(2)}_${Date.now()}`);

const EMPTY_FIELD = () => ({
  id: NEW_ID(),
  label: "",
  required: false,
  type: "passfail",
  valueType: null,              // null | "number" | "text"
  allowPhoto: false,
  allowScan: false,
  allowText: false,             // extra free-text (separate from failure note)
  meta: {
    requireOnFail: {            // N/P/S/V required when result === fail
      note: true,               // default true so failures get at least a note
      photo: false,
      scan: false,
      value: false,
    },
  },
});

function normField(f) {
  const base = { ...EMPTY_FIELD(), ...(f || {}) };
  const allowText  = !!(f?.allowText || f?.text);
  const allowScan  = !!(f?.allowScan || f?.scan || f?.type === "scan");
  const allowPhoto = !!(f?.allowPhoto || f?.photo);

  let valueType = null;
  const t = String(f?.valueType || f?.type || "passfail").toLowerCase();
  if (t === "number") valueType = "number";
  if (t === "text")   valueType = "text";

  const req = {
    note:  "requireOnFail" in (f?.meta || {}) ? !!f.meta.requireOnFail?.note  : true,
    photo: !!f?.meta?.requireOnFail?.photo,
    scan:  !!f?.meta?.requireOnFail?.scan,
    value: !!f?.meta?.requireOnFail?.value,
  };

  return {
    ...base,
    id: String(f?.id || f?._id || base.id),
    label: f?.label || f?.title || "",
    required: !!f?.required,
    type: "passfail",
    valueType,
    allowPhoto,
    allowScan,
    allowText,
    meta: { ...(f?.meta || {}), requireOnFail: req },
  };
}

function normScope(s) {
  const hasProjects = Array.isArray(s?.projectIds) && s.projectIds.length > 0;
  const hasTasks    = Array.isArray(s?.taskIds)    && s.taskIds.length > 0;
  const hasRoles    = Array.isArray(s?.roles)      && s.roles.length > 0;
  const isGlobal    = !!(s?.isGlobal ?? (!hasProjects && !hasTasks && !hasRoles));
  return {
    isGlobal,
    projectIds: hasProjects ? s.projectIds.map(String) : [],
    taskIds:    hasTasks    ? s.taskIds.map(String)    : [],
    roles:      hasRoles    ? s.roles                  : [],
  };
}

function toBuilderValue(v) {
  const fields = Array.isArray(v?.fields)
    ? v.fields.map(normField)
    : Array.isArray(v?.schema)
    ? v.schema.map(normField)
    : [];
  return {
    title: v?.title || v?.name || "",
    description: v?.description || "",
    version: v?.version ?? 1,
    status: v?.status || (v?.active === false ? "archived" : "active"),
    type: v?.type || v?.category || "standard", // "standard" | "signoff"
    scope: normScope(v?.scope || {}),
    fields,
  };
}

function fromBuilderValue(v) {
  const title = (v.title || v.name || "").trim() || "Untitled inspection form";
  const fields = v.fields.map((f, idx) => ({
    id: String(f.id || idx),
    label: f.label || `Item ${idx + 1}`,
    required: !!f.required,
    type: "passfail",
    valueType: f.valueType || null,
    allowPhoto: !!f.allowPhoto,
    allowScan:  !!f.allowScan,
    allowText:  !!f.allowText,
    meta: {
      ...(f.meta || {}),
      requireOnFail: {
        note:  !!f.meta?.requireOnFail?.note,
        photo: !!f.meta?.requireOnFail?.photo,
        scan:  !!f.meta?.requireOnFail?.scan,
        value: !!f.meta?.requireOnFail?.value,
      },
    },
  }));
  const scope = normScope(v.scope || {});
  return {
    name: title,
    title,
    description: v.description || "",
    version: v.version ?? 1,
    status: v.status || "active",
    type: v.type || "standard",
    active: String(v.status || "active").toLowerCase() === "active",
    fields,
    schema: fields,
    definition: fields,
    form: fields,
    scope: {
      isGlobal: !!scope.isGlobal,
      projectIds: scope.projectIds,
      taskIds: scope.taskIds,
      roles: scope.roles,
    },
  };
}

export default function InspectionFormBuilder({ value, onSave, onCancel }) {
  const [state, setState] = useState(() => toBuilderValue(value || {}));
  const [projects, setProjects] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [roles, setRoles] = useState(FALLBACK_ROLES);
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  // Sync if parent hands a new value
  useEffect(() => { setState(toBuilderValue(value || {})); }, [JSON.stringify(value || {})]);

  // Load projects + roles
  useEffect(() => {
    (async () => {
      try {
        const prjs = await listProjectsApi({ limit: 1000 });
        setProjects(Array.isArray(prjs) ? prjs : []);
      } catch {}
      try {
        let r;
        try { r = await api.get("/roles"); } catch (e1) {
          if (e1?.response?.status !== 404) throw e1;
          r = await api.get("/users/roles");
        }
        const rs = Array.isArray(r?.data?.roles) ? r.data.roles :
                   Array.isArray(r?.data)        ? r.data        : [];
        setRoles(rs.length ? rs : FALLBACK_ROLES);
      } catch { setRoles(FALLBACK_ROLES); }
    })();
  }, []);

  // Load tasks when project selection changes
  const selectedProjectId = state.scope.isGlobal ? null : state.scope.projectIds?.[0] || null;
  useEffect(() => {
    (async () => {
      if (!selectedProjectId) { setTasks([]); return; }
      try {
        const ts = await listProjectTasks(selectedProjectId, { limit: 1000 });
        setTasks(Array.isArray(ts) ? ts : []);
      } catch { setTasks([]); }
    })();
  }, [selectedProjectId]);

  const setField = (idx, patch) =>
    setState((s) => {
      const next = { ...s, fields: [...s.fields] };
      next.fields[idx] = { ...next.fields[idx], ...patch };
      return next;
    });

  const moveField = (idx, dir) =>
    setState((s) => {
      const a = [...s.fields];
      const j = idx + dir;
      if (j < 0 || j >= a.length) return s;
      [a[idx], a[j]] = [a[j], a[idx]];
      return { ...s, fields: a };
    });

  const removeField = (idx) =>
    setState((s) => {
      const a = [...s.fields];
      a.splice(idx, 1);
      return { ...s, fields: a };
    });

  const addField = () => setState((s) => ({ ...s, fields: [...s.fields, EMPTY_FIELD()] }));

  const canSave = useMemo(() => {
    if (!state.title.trim()) return false;
    if (!state.fields.length) return false;
    if (!state.fields.every((f) => (f.label || "").trim().length > 0)) return false;
    return true;
  }, [state.title, state.fields]);

  async function handleSave() {
    setErr("");
    if (!canSave) {
      setErr("Please give the form a title and at least one item with a label.");
      return;
    }
    if (!state.scope.isGlobal) {
      const hasAny =
        (state.scope.projectIds?.length || 0) > 0 ||
        (state.scope.taskIds?.length || 0) > 0 ||
        (state.scope.roles?.length || 0) > 0;
      if (!hasAny) {
        setErr("This form is scoped. Select a project and/or task and/or roles.");
        return;
      }
    }
    setSaving(true);
    try { await onSave?.(fromBuilderValue(state)); }
    catch (e) { setErr(e?.response?.data?.error || e?.message || "Save failed"); }
    finally { setSaving(false); }
  }

  const scopeBadge = state.scope.isGlobal ? "Global form" : "Scoped form";

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm text-gray-600">{scopeBadge}</div>
          <h2 className="text-xl font-semibold">Inspection Form Builder</h2>
        </div>
        <div className="flex items-center gap-2">
          <button className="px-3 py-2 border rounded" onClick={onCancel}>Cancel</button>
          <button
            className="px-3 py-2 border rounded disabled:opacity-50"
            disabled={!canSave || saving}
            onClick={handleSave}
            title={!canSave ? "Enter a title and at least one item with a label" : "Save form"}
          >
            {saving ? "Saving…" : "Save form"}
          </button>
        </div>
      </div>

      {err && <div className="text-red-600">{err}</div>}

      {/* Basics */}
      <div className="border rounded p-3 grid md:grid-cols-2 gap-3">
        <label className="text-sm">
          Form title
          <input
            className="border p-2 w-full mt-1"
            value={state.title}
            onChange={(e) => setState((s) => ({ ...s, title: e.target.value }))}
            placeholder="e.g., Site Visit, Vehicle Pre-trip, Toolbox Talk…"
          />
        </label>

        <label className="text-sm">
          Form type
          <select
            className="border p-2 w-full mt-1"
            value={state.type || "standard"}
            onChange={(e) => setState((s) => ({ ...s, type: e.target.value }))}
            title="“Sign-off” can be used later to gate task/milestone completion."
          >
            <option value="standard">Standard</option>
            <option value="signoff">Sign-off</option>
          </select>
        </label>

        <label className="text-sm md:col-span-2">
          Description (optional)
          <textarea
            rows={2}
            className="border p-2 w-full mt-1"
            value={state.description}
            onChange={(e) => setState((s) => ({ ...s, description: e.target.value }))}
            placeholder="Short description shown to inspectors…"
          />
        </label>
      </div>

      {/* Scope */}
      <div className="border rounded p-3 space-y-3">
        <div className="font-medium">Scope</div>
        <div className="flex items-center gap-4 text-sm">
          <label className="inline-flex items-center gap-2">
            <input
              type="radio"
              checked={state.scope.isGlobal}
              onChange={() =>
                setState((s) => ({
                  ...s,
                  scope: { isGlobal: true, projectIds: [], taskIds: [], roles: [] },
                }))
              }
            />
            Global (available everywhere)
          </label>
          <label className="inline-flex items-center gap-2">
            <input
              type="radio"
              checked={!state.scope.isGlobal}
              onChange={() =>
                setState((s) => ({ ...s, scope: { ...s.scope, isGlobal: false } }))
              }
            />
            Assign to project / task / roles
          </label>
        </div>

        {!state.scope.isGlobal && (
          <div className="grid md:grid-cols-3 gap-3">
            <label className="text-sm">
              Project (optional)
              <select
                className="border p-2 w-full mt-1"
                value={selectedProjectId || ""}
                onChange={(e) => {
                  const pid = e.target.value || null;
                  setState((s) => ({
                    ...s,
                    scope: { ...s.scope, isGlobal: false, projectIds: pid ? [pid] : [], taskIds: [] },
                  }));
                }}
              >
                <option value="">— Any project —</option>
                {projects.map((p) => (
                  <option key={String(p._id || p.id)} value={String(p._id || p.id)}>
                    {p.name || p.title || p.projectName || `Project ${p._id || p.id}`}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-sm">
              Task (optional)
              <select
                className="border p-2 w-full mt-1"
                value={state.scope.taskIds?.[0] || ""}
                onChange={(e) => {
                  const tid = e.target.value || "";
                  setState((s) => ({
                    ...s,
                    scope: { ...s.scope, isGlobal: false, taskIds: tid ? [tid] : [] },
                  }));
                }}
                disabled={!selectedProjectId}
                title={selectedProjectId ? "" : "Select a project to filter tasks"}
              >
                <option value="">— Any task —</option>
                {tasks.map((t) => {
                  const tid = String(t._id || t.id);
                  const label = t.title || t.name || t.taskName || (t.number ? `#${t.number}` : `Task ${tid}`);
                  return (
                    <option key={tid} value={tid}>
                      {label}
                    </option>
                  );
                })}
              </select>
            </label>

            <label className="text-sm">
              Roles (optional)
              <select
                multiple
                className="border p-2 w-full mt-1"
                value={state.scope.roles || []}
                onChange={(e) => {
                  const vals = Array.from(e.target.selectedOptions).map((o) => o.value);
                  setState((s) => ({ ...s, scope: { ...s.scope, roles: vals, isGlobal: false } }));
                }}
              >
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <div className="text-xs text-gray-600 mt-1">If empty, any role may use the form.</div>
            </label>
          </div>
        )}
      </div>

      {/* Items */}
      <div className="border rounded p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="font-medium">Items</div>
          <button type="button" className="px-2 py-1 border rounded" onClick={addField}>
            + Add item
          </button>
        </div>

        <div className="space-y-2">
          {state.fields.map((f, idx) => {
            const req = f.meta?.requireOnFail || { note: true, photo: false, scan: false, value: false };
            const toggleStyle = (active) => ({
              padding: "4px 10px",
              borderRadius: 6,
              border: `1px solid ${active ? "rgba(0,0,0,0.45)" : "rgba(0,0,0,0.25)"}`,
              background: active ? "rgba(0,0,0,0.15)" : "transparent",
              fontWeight: active ? 700 : 500,
              letterSpacing: 0.4,
            });

            return (
              <div
                key={f.id}
                className="grid gap-2 items-center"
                style={{ gridTemplateColumns: "32px 1fr 92px 220px 220px 160px 32px" }}
              >
                {/* Reorder */}
                <div className="flex items-center justify-center">
                  <div className="flex flex-col">
                    <button
                      type="button"
                      className="border rounded text-xs"
                      onClick={() => moveField(idx, -1)}
                      disabled={idx === 0}
                      title="Move up"
                      style={{ padding: "2px 6px", opacity: idx === 0 ? 0.5 : 1 }}
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      className="border rounded text-xs mt-1"
                      onClick={() => moveField(idx, +1)}
                      disabled={idx === state.fields.length - 1}
                      title="Move down"
                      style={{ padding: "2px 6px", opacity: idx === state.fields.length - 1 ? 0.5 : 1 }}
                    >
                      ▼
                    </button>
                  </div>
                </div>

                {/* Label */}
                <input
                  className="border p-2 w-full"
                  placeholder={`Item ${idx + 1} label…`}
                  value={f.label}
                  onChange={(e) => setField(idx, { label: e.target.value })}
                />

                {/* Required PF/NA */}
                <label className="inline-flex items-center gap-1 text-sm">
                  <input
                    type="checkbox"
                    checked={!!f.required}
                    onChange={(e) => setField(idx, { required: e.target.checked })}
                  />
                  Required
                </label>

                {/* Allow attachments */}
                <div className="text-sm">
                  <div className="flex items-center gap-2 flex-wrap">
                    <label className="inline-flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={!!f.allowPhoto}
                        onChange={(e) => setField(idx, { allowPhoto: e.target.checked })}
                      />
                      Photo
                    </label>
                    <label className="inline-flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={!!f.allowScan}
                        onChange={(e) => setField(idx, { allowScan: e.target.checked })}
                      />
                      Scan
                    </label>
                    <label className="inline-flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={!!f.allowText}
                        onChange={(e) => setField(idx, { allowText: e.target.checked })}
                      />
                      Extra text
                    </label>
                  </div>
                </div>

                {/* Optional Value type */}
                <div className="text-sm">
                  <label className="block">
                    Value
                    <select
                      className="border p-1 w-full mt-1"
                      value={f.valueType || ""}
                      onChange={(e) =>
                        setField(idx, {
                          valueType: e.target.value || null,
                          meta: { ...f.meta, requireOnFail: { ...req } },
                        })
                      }
                    >
                      <option value="">— None —</option>
                      <option value="number">Number</option>
                      <option value="text">Text</option>
                    </select>
                  </label>
                </div>

                {/* Require on fail (stronger visual state) */}
                <div className="text-sm">
                  <div className="mb-1">Fail requires</div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setField(idx, { meta: { ...f.meta, requireOnFail: { ...req, note: !req.note } } })}
                      style={toggleStyle(!!req.note)}
                      title="Require a failure note"
                    >N</button>
                    <button
                      type="button"
                      onClick={() => setField(idx, { meta: { ...f.meta, requireOnFail: { ...req, photo: !req.photo } } })}
                      style={toggleStyle(!!req.photo)}
                      title="Require at least one photo on fail"
                    >P</button>
                    <button
                      type="button"
                      onClick={() => setField(idx, { meta: { ...f.meta, requireOnFail: { ...req, scan: !req.scan } } })}
                      style={toggleStyle(!!req.scan)}
                      title="Require a scan/code on fail"
                    >S</button>
                    <button
                      type="button"
                      onClick={() => setField(idx, { meta: { ...f.meta, requireOnFail: { ...req, value: !req.value } } })}
                      style={toggleStyle(!!req.value)}
                      title="Require the Value field on fail"
                    >V</button>
                  </div>
                </div>

                {/* Delete */}
                <div className="flex items-center justify-center">
                  <button
                    type="button"
                    className="px-2 py-1 border rounded"
                    onClick={() => removeField(idx)}
                    title="Remove item"
                  >
                    ✕
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {!state.fields.length && (
          <div className="text-sm text-gray-600">No items yet. Click “Add item”.</div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center gap-2">
        <button className="px-3 py-2 border rounded" onClick={onCancel}>Cancel</button>
        <button
          className="px-3 py-2 border rounded disabled:opacity-50"
          disabled={!canSave || saving}
          onClick={handleSave}
        >
          {saving ? "Saving…" : "Save form"}
        </button>
      </div>

      <div className="text-xs text-gray-600">
        ▲/▼ reorder. N/P/S/V show darker when active. Attachments are always available in the runner if enabled here;
        they become <b>required</b> when the item is marked <b>Fail</b>, according to N/P/S/V.
      </div>
    </div>
  );
}
