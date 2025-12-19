// core-frontend/src/pages/AdminInspectionFormBuilder.jsx
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { createForm, getForm, updateForm } from "../lib/inspectionApi";
import { api } from "../lib/api";

const CANON_ROLES = [
  "user",
  "group-leader",
  "project-manager",
  "manager",
  "admin",
  "superadmin",
];

// ✨ Add "performance"
const SUBJECT_TYPES = ["none", "vehicle", "asset", "performance"];

const DEFAULT_SCORING = () => ({
  mode: "any-fail",
  maxNonCriticalFails: 0,
  minPassPercent: 100,
});

const DEFAULT_SUBJECT = () => ({
  type: "none",
  lockToId: "",
  lockLabel: "",
});

const DEFAULT_FORM = () => ({
  title: "",
  description: "",
  formType: "standard",
  scope: { type: "global", projectId: "", taskId: "", milestoneId: "", projectName:"", taskName:"", milestoneName:"" },
  subject: DEFAULT_SUBJECT(),
  rolesAllowed: [],
  items: [],
  scoring: DEFAULT_SCORING(),
});

const DEFAULT_ITEM = () => ({
  label: "",
  allowPhoto: false,
  allowScan: false,
  allowNote: true,
  requireEvidenceOnFail: false,
  requireCorrectiveOnFail: true,
  criticalOnFail: false,
});

function niceCase(s) {
  const t = String(s || "").toLowerCase();
  if (t === "signoff") return "Sign-off";
  if (t === "standard") return "Standard";
  return t.replace(/[-_]/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}
function labelOf(x){ return x?.name || x?.title || x?.label || ""; }
function clamp(n, lo, hi){ const x = Number.isFinite(+n) ? +n : 0; return Math.max(lo, Math.min(hi, x)); }

/* ---------- Vehicle/Asset display helpers ---------- */
function vehicleReg(v){ return v?.registration || v?.reg || v?.plate || v?.vrn || ""; }
function vehicleMakeModelYear(v){
  const make = v?.make || v?.manufacturer || "";
  const model = v?.model || "";
  const year = v?.year || v?.yom || v?.manufacturedYear || "";
  const parts = [make, model, year && String(year)];
  return parts.filter(Boolean).join(" ").trim();
}
function vehicleOptionText(v){
  const reg = vehicleReg(v);
  const mmY = vehicleMakeModelYear(v);
  const right = mmY || labelOf(v) || "";
  return reg ? `[${reg}] ${right}` : (right || "(vehicle)");
}
function assetTag(a){ return a?.tag || a?.code || a?.serial || a?.serialNumber || ""; }
function assetMakeModel(a){
  const make = a?.make || a?.manufacturer || "";
  const model = a?.model || "";
  const parts = [make, model].filter(Boolean);
  return parts.join(" ").trim();
}
function assetLockedLabel(a){ const mm = assetMakeModel(a); return mm || labelOf(a) || ""; }
function assetOptionText(a){
  const tag = assetTag(a);
  const mm = assetMakeModel(a);
  const right = mm || labelOf(a) || "";
  return tag ? `[${tag}] ${right}` : (right || "(asset)");
}

export default function AdminInspectionFormBuilder() {
  const { id } = useParams(); // edit optional
  const nav = useNavigate();

  const [form, setForm] = useState(null);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [saving, setSaving] = useState(false);
  const [loadErr, setLoadErr] = useState("");
  const isEdit = !!id;

  // Scoped pick-lists
  const [projects, setProjects] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [milestones, setMilestones] = useState([]);

  // Subject lists when scoped to a project
  const [vehicles, setVehicles] = useState([]);
  const [assets, setAssets] = useState([]);

  // ✨ Performance: GL+ user options (works global or scoped)
  const [assessedQuery, setAssessedQuery] = useState("");
  const [assessedUsers, setAssessedUsers] = useState([]);
  const [assessedLoading, setAssessedLoading] = useState(false);

  // Load (or initialize)
  useEffect(() => {
    let mounted = true;
    (async () => {
      setLoadErr("");
      if (!isEdit) {
        if (mounted) {
          setForm(DEFAULT_FORM());
          setActiveIdx(-1);
        }
        return;
      }
      try {
        const f = await getForm(id);
        if (!mounted) return;
        if (!f || f.isDeleted) throw new Error("Form not found or deleted");

        const safe = { ...DEFAULT_FORM(), ...f };
        safe.scope = { ...DEFAULT_FORM().scope, ...(f.scope || {}) };
        safe.subject = { ...DEFAULT_SUBJECT(), ...(f.subject || {}) };
        safe.rolesAllowed = Array.isArray(f.rolesAllowed) ? f.rolesAllowed : [];
        safe.items = Array.isArray(f.items)
          ? f.items.map((it) => ({ ...DEFAULT_ITEM(), ...it }))
          : [];
        safe.scoring = { ...DEFAULT_SCORING(), ...(f.scoring || {}) };

        setForm(safe);
        setActiveIdx(-1);
      } catch (e) {
        if (!mounted) return;
        setForm(null);
        setLoadErr(e?.response?.data?.error || e?.message || "Failed to load form");
      }
    })();
    return () => { mounted = false; };
  }, [id, isEdit]);

  // Load project list when Scoped
  useEffect(() => {
    if (!form || form.scope?.type !== "scoped") return;
    (async () => {
      try {
        const { data } = await api.get("/projects", { params: { limit: 500 } });
        setProjects(Array.isArray(data) ? data : []);
      } catch { setProjects([]); }
    })();
  }, [form?.scope?.type]);

  // Load tasks when project changes
  useEffect(() => {
    if (!form || form.scope?.type !== "scoped" || !form.scope?.projectId) {
      setTasks([]); setMilestones([]); return;
    }
    (async () => {
      try {
        const { data } = await api.get("/tasks", { params: { projectId: form.scope.projectId, limit: 1000 } });
        setTasks(Array.isArray(data) ? data : []);
      } catch {
        try {
          const { data } = await api.get(`/projects/${form.scope.projectId}/tasks`);
          setTasks(Array.isArray(data) ? data : []);
        } catch { setTasks([]); }
      }
    })();
  }, [form?.scope?.type, form?.scope?.projectId]);

  // Load milestones when task changes
  useEffect(() => {
    if (!form || form.scope?.type !== "scoped" || !form.scope?.taskId) {
      setMilestones([]); return;
    }
    (async () => {
      try {
        const { data } = await api.get(`/tasks/${form.scope.taskId}/milestones`);
        setMilestones(Array.isArray(data) ? data : []);
      } catch { setMilestones([]); }
    })();
  }, [form?.scope?.type, form?.scope?.taskId]);

  // Load subject lists (vehicles/assets) when scoped + project selected
  useEffect(() => {
    if (!form || form.scope?.type !== "scoped" || !form.scope?.projectId) {
      setVehicles([]); setAssets([]); return;
    }
    const pid = form.scope.projectId;

    (async () => {
      // VEHICLES
      try {
        let res = await api.get(`/projects/${pid}/vehicles`, { params: { limit: 1000 } });
        setVehicles(Array.isArray(res.data) ? res.data : []);
      } catch {
        try {
          let res = await api.get(`/vehicles`, { params: { projectId: pid, limit: 1000 } });
          setVehicles(Array.isArray(res.data) ? res.data : []);
        } catch { setVehicles([]); }
      }
    })();

    (async () => {
      // ASSETS
      try {
        let res = await api.get(`/projects/${pid}/assets`, { params: { limit: 1000 } });
        setAssets(Array.isArray(res.data) ? res.data : []);
      } catch {
        try {
          let res = await api.get(`/assets`, { params: { projectId: pid, limit: 1000 } });
          setAssets(Array.isArray(res.data) ? res.data : []);
        } catch { setAssets([]); }
      }
    })();
  }, [form?.scope?.type, form?.scope?.projectId]);

  // ✨ Load assessed users (GL+) for Performance – available both global & scoped
  useEffect(() => {
    let cancel = false;
    const run = async () => {
      if (!form || form.subject?.type !== "performance") { setAssessedUsers([]); return; }
      setAssessedLoading(true);
      try {
        const { data } = await api.get("/inspections/candidates/assessed-users", {
          params: { q: assessedQuery || "", minRole: "group-leader", limit: 200 },
        });
        if (!cancel) setAssessedUsers(Array.isArray(data) ? data : []);
      } catch {
        if (!cancel) setAssessedUsers([]);
      } finally {
        if (!cancel) setAssessedLoading(false);
      }
    };
    run();
    return () => { cancel = true; };
  }, [form?.subject?.type, assessedQuery]);

  const canSave = useMemo(() => {
    if (!form) return false;
    if (!String(form.title || "").trim()) return false;
    if (!Array.isArray(form.items) || form.items.length === 0) return false;
    if (!form.items.some((it) => String(it.label || "").trim())) return false;

    if (form.scoring?.mode === "percent") {
      const pct = clamp(form.scoring?.minPassPercent, 0, 100);
      if (!Number.isFinite(pct)) return false;
    }
    if (form.scoring?.mode === "tolerance") {
      const maxF = clamp(form.scoring?.maxNonCriticalFails, 0, 999);
      if (!Number.isFinite(maxF)) return false;
    }

    // If subject locked, ensure label/id present
    if (form.subject?.type === "performance" && (form.subject?.lockToId || form.subject?.lockLabel)) {
      if (!form.subject.lockToId || !form.subject.lockLabel) return false;
    }
    return true;
  }, [form]);

  const patchForm = (patch) => setForm((prev) => ({ ...prev, ...patch }));
  const patchScope = (patch) =>
    setForm((prev) => ({ ...prev, scope: { ...(prev?.scope || {}), ...patch } }));
  const setScoring = (patch) =>
    setForm((prev) => ({ ...prev, scoring: { ...(prev?.scoring || DEFAULT_SCORING()), ...patch } }));
  const patchSubject = (patch) =>
    setForm((prev) => ({ ...prev, subject: { ...(prev?.subject || DEFAULT_SUBJECT()), ...patch } }));

  // Role toggles
  const toggleRole = (role) => {
    setForm((prev) => {
      const list = new Set(prev.rolesAllowed || []);
      if (list.has(role)) list.delete(role);
      else list.add(role);
      return { ...prev, rolesAllowed: [...list] };
    });
  };
  const setAllRoles = (on) => {
    setForm((prev) => ({ ...prev, rolesAllowed: on ? [...CANON_ROLES] : [] }));
  };

  // Items
  const addItem = () => {
    setForm((prev) => {
      const items = [...(prev.items || []), DEFAULT_ITEM()];
      return { ...prev, items };
    });
    setActiveIdx((form?.items?.length || 0));
  };
  const updateItem = (idx, patch) => {
    setForm((prev) => {
      const items = [...prev.items];
      items[idx] = { ...items[idx], ...patch };
      return { ...prev, items };
    });
  };
  const removeItem = (idx) => {
    setForm((prev) => {
      const items = prev.items.filter((_, i) => i !== idx);
      return { ...prev, items };
    });
    setActiveIdx(-1);
  };
  const moveItem = (idx, dir) => {
    setForm((prev) => {
      const items = [...prev.items];
      const j = idx + dir;
      if (j < 0 || j >= items.length) return prev;
      [items[idx], items[j]] = [items[j], items[idx]];
      return { ...prev, items };
    });
    setActiveIdx((a) => (a === idx ? idx + dir : a === idx + dir ? idx : a));
  };

  // Reset subject lock when project changes (scoped) – vehicles/assets lock depends on project
  useEffect(() => {
    if (!form) return;
    if (form.scope?.type === "scoped" && (form.subject?.type === "vehicle" || form.subject?.type === "asset")) {
      patchSubject({ lockToId: "", lockLabel: "" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form?.scope?.projectId]);

  const onSave = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      const payload = scrub(form);
      if (isEdit) await updateForm(id, payload);
      else await createForm(payload);
      nav("/admin/inspections/forms");
    } catch (e) {
      alert(e?.response?.data?.error || e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  // --------- DO NOT place any hooks below this line (early returns follow) ---------
  if (loadErr) {
    return (
      <div className="max-w-3xl mx-auto p-6">
        <h1 className="text-2xl font-semibold mb-2">Edit Inspection Form</h1>
        <div className="rounded-xl border p-4 bg-red-50 border-red-200 text-red-700">
          {loadErr}
        </div>
        <div className="mt-4">
          <button className="btn" onClick={()=>nav("/admin/inspections/forms")}>Back to forms</button>
        </div>
      </div>
    );
  }

  if (!form) return <div className="p-4">Loading…</div>;

  const pill = (on) => `pill ${on ? "active" : ""}`;

  const scoring = form.scoring || DEFAULT_SCORING();
  const scoringMode = scoring.mode || "any-fail";
  const subject = form.subject || DEFAULT_SUBJECT();
  const isScoped = form.scope?.type === "scoped";

  // Which list are we drawing options from (vehicles/assets only)
  const subjectOptions =
    subject.type === "vehicle" ? vehicles :
    subject.type === "asset" ? assets : [];

  return (
    <div className="max-w-5xl mx-auto p-4">
      {/* Small local styles */}
      <style>{`
        .mini-chip{display:inline-block;border:1px solid var(--border);padding:2px 8px;border-radius:9999px;font-size:12px;margin-right:6px;color:var(--muted)}
        .toggle-pills .pill{border:1px solid var(--border);padding:.35rem .7rem;border-radius:9999px;cursor:pointer;font-weight:600;background:var(--panel);color:var(--text)}
        .toggle-pills .pill.active{background:var(--accent);border-color:var(--accent);color:#fff}
      `}</style>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-semibold">
          {isEdit ? "Edit Inspection Form" : "New Inspection Form"}
        </h1>
        <div className="flex items-center gap-2">
          <button className="btn" onClick={() => nav("/admin/inspections/forms")}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!canSave || saving}
            onClick={onSave}
          >
            {saving ? "Saving…" : "Save Form"}
          </button>
        </div>
      </div>

      {/* Meta */}
      <div className="card">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <div className="font-medium">Form Title</div>
            <input
              className="input input-bordered w-full mt-1"
              placeholder="e.g. Daily Site Safety"
              value={form.title}
              onChange={(e) => patchForm({ title: e.target.value })}
            />
          </label>

          {/* Form type as pills */}
          <div className="block">
            <div className="font-medium">Form Type</div>
            <div className="toggle-pills flex gap-2 mt-2">
              {["standard", "signoff"].map((t) => (
                <button
                  key={t}
                  type="button"
                  className={pill(form.formType === t)}
                  onClick={() => patchForm({ formType: t })}
                >
                  {niceCase(t)}
                </button>
              ))}
            </div>
          </div>
        </div>

        <label className="block mt-3">
          <div className="font-medium">Description (optional)</div>
          <textarea
            className="textarea textarea-bordered w-full mt-1"
            rows={3}
            value={form.description || ""}
            onChange={(e) => patchForm({ description: e.target.value })}
          />
        </label>
      </div>

      {/* Scope */}
      <div className="card">
        <div className="font-medium mb-2">Scope</div>
        <div className="row">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              checked={form.scope?.type === "global"}
              onChange={() =>
                patchScope({ type: "global", projectId: "", taskId: "", milestoneId: "", projectName:"", taskName:"", milestoneName:"" })
              }
            />
            Global
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              checked={form.scope?.type === "scoped"}
              onChange={() => patchScope({ type: "scoped" })}
            />
            Scoped
          </label>
        </div>

        {form.scope?.type === "scoped" && (
          <div className="grid gap-3 sm:grid-cols-3 mt-2">
            {/* Project select */}
            <label className="block">
              <div className="muted">Project</div>
              <select
                className="select select-bordered w-full mt-1"
                value={form.scope?.projectId || ""}
                onChange={(e) => {
                  const projectId = e.target.value;
                  const proj = (projects || []).find(p => String(p._id||p.id) === String(projectId));
                  patchScope({
                    projectId,
                    projectName: labelOf(proj) || "",
                    taskId: "",
                    milestoneId: "",
                    taskName: "",
                    milestoneName: ""
                  });
                }}
              >
                <option value="">{projects.length ? "— select project —" : "Loading projects…"}</option>
                {projects.map((p) => (
                  <option key={p._id || p.id} value={p._id || p.id}>
                    {labelOf(p)}
                  </option>
                ))}
              </select>
            </label>

            {/* Task select */}
            <label className="block">
              <div className="muted">Task</div>
              <select
                className="select select-bordered w-full mt-1"
                value={form.scope?.taskId || ""}
                onChange={(e) => {
                  const taskId = e.target.value;
                  const t = (tasks || []).find(x => String(x._id||x.id) === String(taskId));
                  patchScope({
                    taskId,
                    taskName: labelOf(t) || "",
                    milestoneId: "",
                    milestoneName: ""
                  });
                }}
                disabled={!form.scope?.projectId}
              >
                <option value="">{tasks.length ? "— any task —" : (form.scope?.projectId ? "Loading tasks…" : "Select a project…")}</option>
                {tasks.map((t) => (
                  <option key={t._id || t.id} value={t._id || t.id}>
                    {labelOf(t)}
                  </option>
                ))}
              </select>
            </label>

            {/* Milestone select */}
            <label className="block">
              <div className="muted">Milestone</div>
              <select
                className="select select-bordered w-full mt-1"
                value={form.scope?.milestoneId || ""}
                onChange={(e) => {
                  const milestoneId = e.target.value;
                  const m = (milestones || []).find(x => String(x._id||x.id) === String(milestoneId));
                  patchScope({ milestoneId, milestoneName: labelOf(m) || "" });
                }}
                disabled={!form.scope?.taskId}
              >
                <option value="">{milestones.length ? "— any milestone —" : (form.scope?.taskId ? "Loading milestones…" : "Select a task…")}</option>
                {milestones.map((m) => (
                  <option key={m._id || m.id} value={m._id || m.id}>
                    {labelOf(m)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </div>

      {/* Subject (what is being inspected) */}
      <div className="card">
        <div className="font-medium mb-2">Subject</div>
        <div className="toggle-pills flex flex-wrap gap-2">
          {SUBJECT_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              className={pill(subject.type === t)}
              onClick={() => {
                // switching type clears lock
                patchSubject({ type: t, lockToId: "", lockLabel: "" });
              }}
            >
              {t === "none" ? "General" : niceCase(t)}
            </button>
          ))}
        </div>

        {/* Lock to: Vehicles/Assets (scoped project lists) */}
        {subject.type !== "none" && (subject.type === "vehicle" || subject.type === "asset") && (
          <>
            {isScoped ? (
              <div className="mt-3 grid sm:grid-cols-2 gap-3">
                <label className="block">
                  <div className="muted">
                    {subject.type === "vehicle" ? "Vehicle (optional)" : "Asset (optional)"}
                  </div>
                  <select
                    className="select select-bordered w-full mt-1"
                    value={subject.lockToId || ""}
                    onChange={(e) => {
                      const id = e.target.value;
                      const list = subject.type === "vehicle" ? vehicles : assets;
                      const obj = (list || []).find(x => String(x._id||x.id) === String(id));

                      if (subject.type === "vehicle") {
                        patchSubject({
                          lockToId: id,
                          lockLabel: obj ? vehicleMakeModelYear(obj) : "",
                        });
                      } else {
                        patchSubject({
                          lockToId: id,
                          lockLabel: obj ? assetLockedLabel(obj) : "",
                        });
                      }
                    }}
                    disabled={!form.scope?.projectId}
                  >
                    <option value="">
                      {form.scope?.projectId
                        ? (subject.type === "vehicle"
                            ? "— select by registration —"
                            : "— select asset —")
                        : "Select a project first…"}
                    </option>

                    {subject.type === "vehicle" &&
                      subjectOptions.map((v) => (
                        <option key={v._id || v.id} value={v._id || v.id}>
                          {vehicleOptionText(v)}
                        </option>
                      ))}

                    {subject.type === "asset" &&
                      subjectOptions.map((a) => (
                        <option key={a._id || a.id} value={a._id || a.id}>
                          {assetOptionText(a)}
                        </option>
                      ))}
                  </select>
                </label>
                <div className="text-sm self-end">
                  If left blank, inspectors will choose the {subject.type} at run-time. Lists are filtered to the selected project.
                </div>
              </div>
            ) : (
              <div className="mt-2 text-sm muted">
                Global form: the inspector will choose the {subject.type} when running. They can also choose project / task / milestone at run-time.
              </div>
            )}
          </>
        )}

        {/* ✨ Lock to: Performance (GL+ users) — available global or scoped */}
        {subject.type === "performance" && (
          <div className="mt-3 grid sm:grid-cols-2 gap-3">
            <label className="block">
              <div className="muted">Lock to User (optional)</div>
              <input
                className="input input-bordered w-full mt-1"
                placeholder="Search name or email…"
                value={assessedQuery}
                onChange={(e) => setAssessedQuery(e.target.value)}
              />
              <select
                className="select select-bordered w-full mt-2"
                value={subject.lockToId || ""}
                onChange={(e) => {
                  const id = e.target.value;
                  const u = (assessedUsers || []).find(x => String(x._id) === String(id));
                  patchSubject({
                    lockToId: id,
                    lockLabel: u ? (u.name || u.email || u.username || "") : "",
                  });
                }}
                disabled={assessedLoading}
              >
                <option value="">{assessedLoading ? "Loading…" : "— select user (GL+) —"}</option>
                {(assessedUsers || []).map(u => (
                  <option key={u._id} value={u._id}>
                    {u.name || u.email || u.username || u._id}
                  </option>
                ))}
              </select>
              {subject.lockToId && (
                <div className="text-xs text-gray-600 mt-1">
                  Locked to: {subject.lockLabel || subject.lockToId}
                </div>
              )}
            </label>
            <div className="text-sm self-end">
              If left blank, the inspector will pick a user (Group Leader and above) at run-time.
            </div>
          </div>
        )}
      </div>

      {/* Roles as toggle buttons */}
      <div className="card">
        <div className="flex items-center justify-between">
          <div className="font-medium">Allowed Roles</div>
          <div className="flex items-center gap-2">
            <button className="btn btn-sm" onClick={() => setAllRoles(true)}>
              Select All
            </button>
            <button className="btn btn-sm" onClick={() => setAllRoles(false)}>
              Clear
            </button>
          </div>
        </div>
        <div className="toggle-pills flex flex-wrap gap-2 mt-2">
          {CANON_ROLES.map((r) => {
            const active = (form.rolesAllowed || []).includes(r);
            return (
              <button
                key={r}
                type="button"
                className={pill(active)}
                onClick={() => toggleRole(r)}
              >
                {niceCase(r)}
              </button>
            );
          })}
        </div>
        <small className="muted block mt-2">Leave empty to allow everyone.</small>
      </div>

      {/* Scoring */}
      <div className="card">
        <div className="font-medium mb-2">Overall Result / Scoring</div>
        <div className="toggle-pills flex flex-wrap gap-2">
          {[
            {key:'any-fail', label:'Any Fail'},
            {key:'tolerance', label:'Tolerance'},
            {key:'percent', label:'Percent'},
          ].map(opt => (
            <button
              key={opt.key}
              type="button"
              className={pill(scoringMode === opt.key)}
              onClick={() => setScoring({ mode: opt.key })}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {scoringMode === "any-fail" && (
          <div className="mt-2 text-sm muted">
            Any failed item results in an overall <b>FAIL</b>. Critical items always auto-fail.
          </div>
        )}

        {scoringMode === "tolerance" && (
          <div className="grid sm:grid-cols-2 gap-3 mt-3">
            <label className="block">
              <div className="muted">Max non-critical FAILs allowed</div>
              <input
                type="number"
                min={0}
                max={999}
                step={1}
                className="input input-bordered w-full mt-1"
                value={scoring.maxNonCriticalFails ?? 0}
                onChange={(e)=> setScoring({ maxNonCriticalFails: clamp(parseInt(e.target.value,10), 0, 999) })}
              />
            </label>
            <div className="text-sm self-end">
              Critical fails still cause overall <b>FAIL</b>.
            </div>
          </div>
        )}

        {scoringMode === "percent" && (
          <div className="grid sm:grid-cols-2 gap-3 mt-3">
            <label className="block">
              <div className="muted">Minimum pass percentage</div>
              <input
                type="number"
                min={0}
                max={100}
                step={1}
                className="input input-bordered w-full mt-1"
                value={scoring.minPassPercent ?? 100}
                onChange={(e)=> setScoring({ minPassPercent: clamp(parseInt(e.target.value,10), 0, 100) })}
              />
            </label>
            <div className="text-sm self-end">
              Calculated over non-N/A items. Critical fails still cause overall <b>FAIL</b>.
            </div>
          </div>
        )}
      </div>

      {/* Items */}
      <div className="card">
        <div className="row">
          <div className="font-medium">Inspection Items</div>
          <button type="button" className="btn btn-primary right" onClick={addItem}>
            Add Item
          </button>
        </div>

        <div className="mt-3">
          {(form.items || []).length === 0 && (
            <div className="muted">No items yet. Click “Add Item”.</div>
          )}

          {(form.items || []).map((it, idx) => {
            const expanded = activeIdx === idx;

            if (!expanded) {
              return (
                <div
                  key={idx}
                  className="row"
                  style={{ padding: "10px 0", borderBottom: "1px solid var(--border)", alignItems: "center" }}
                >
                  <div className="font-medium" style={{ minWidth: 42 }}>{idx + 1}.</div>
                  <div className="flex-1">
                    <div>{it.label || <span className="muted">Untitled item</span>}</div>
                    <div className="mt-1">
                      {it.allowPhoto && <span className="mini-chip">Photo</span>}
                      {it.allowScan && <span className="mini-chip">Scan</span>}
                      {it.allowNote && <span className="mini-chip">Note</span>}
                      {it.requireEvidenceOnFail && <span className="mini-chip">Evidence on fail</span>}
                      {it.requireCorrectiveOnFail && <span className="mini-chip">Corrective on fail</span>}
                      {it.criticalOnFail && <span className="mini-chip">Critical</span>}
                    </div>
                  </div>
                  <div className="right flex items-center gap-2">
                    <button className="btn btn-sm" onClick={() => setActiveIdx(idx)} title="Edit">Edit</button>
                    <button className="btn btn-sm" onClick={() => moveItem(idx, -1)} disabled={idx === 0} title="Move up">↑</button>
                    <button className="btn btn-sm" onClick={() => moveItem(idx, 1)} disabled={idx >= (form.items.length - 1)} title="Move down">↓</button>
                    <button className="btn btn-sm" onClick={() => removeItem(idx)} title="Remove">Remove</button>
                  </div>
                </div>
              );
            }

            // Expanded editor
            return (
              <div key={idx} className="rounded-xl border p-3 mt-3" style={{ borderColor: "var(--border)" }}>
                <div className="row">
                  <div className="font-medium">Item {idx + 1}</div>
                  <div className="right flex items-center gap-2">
                    <button className="btn btn-sm" onClick={() => moveItem(idx, -1)} disabled={idx === 0}>Move Up</button>
                    <button className="btn btn-sm" onClick={() => moveItem(idx, 1)} disabled={idx >= (form.items.length - 1)}>Move Down</button>
                    <button className="btn btn-sm" onClick={() => setActiveIdx(-1)}>Done</button>
                    <button className="btn btn-sm" onClick={() => removeItem(idx)}>Remove</button>
                  </div>
                </div>

                <label className="block mt-2">
                  <div className="font-medium">Label</div>
                  <input
                    className="input input-bordered w-full mt-1"
                    placeholder="What is being inspected?"
                    value={it.label}
                    onChange={(e) => updateItem(idx, { label: e.target.value })}
                  />
                </label>

                <div className="toggle-pills flex flex-wrap gap-2 mt-3">
                  <button
                    type="button"
                    className={pill(!!it.allowPhoto)}
                    onClick={() => updateItem(idx, { allowPhoto: !it.allowPhoto })}
                  >Photo</button>
                  <button
                    type="button"
                    className={pill(!!it.allowScan)}
                    onClick={() => updateItem(idx, { allowScan: !it.allowScan })}
                  >Scan</button>
                  <button
                    type="button"
                    className={pill(it.allowNote !== false)}
                    onClick={() => updateItem(idx, { allowNote: !(it.allowNote !== false) })}
                  >Note</button>
                  <button
                    type="button"
                    className={pill(!!it.requireEvidenceOnFail)}
                    onClick={() => updateItem(idx, { requireEvidenceOnFail: !it.requireEvidenceOnFail })}
                  >Evidence on fail</button>
                  <button
                    type="button"
                    className={pill(it.requireCorrectiveOnFail !== false)}
                    onClick={() => updateItem(idx, { requireCorrectiveOnFail: !(it.requireCorrectiveOnFail !== false) })}
                  >Corrective on fail</button>
                  <button
                    type="button"
                    className={pill(!!it.criticalOnFail)}
                    onClick={() => updateItem(idx, { criticalOnFail: !it.criticalOnFail })}
                  >Critical</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ===== scrub payload to backend shape ===== */
function scrub(f) {
  const scope = f.scope || {};
  const subject = f.subject || DEFAULT_SUBJECT();
  const items = Array.isArray(f.items)
    ? f.items.map((it) => ({
        label: String(it.label || "").trim(),
        allowPhoto: !!it.allowPhoto,
        allowScan: !!it.allowScan,
        allowNote: it.allowNote !== false,
        requireEvidenceOnFail: !!it.requireEvidenceOnFail,
        requireCorrectiveOnFail: it.requireCorrectiveOnFail !== false,
        criticalOnFail: !!it.criticalOnFail,
      }))
    : [];

  const mode = (f.scoring?.mode === 'tolerance' || f.scoring?.mode === 'percent') ? f.scoring.mode : 'any-fail';
  const maxNonCriticalFails = clamp(parseInt(f.scoring?.maxNonCriticalFails,10), 0, 999);
  const minPassPercent = clamp(parseInt(f.scoring?.minPassPercent,10), 0, 100);

  // ✨ subject scrub (now includes "performance")
  const validTypes = new Set(["none","vehicle","asset","performance"]);
  const subjType = validTypes.has(subject.type) ? subject.type : "none";
  const finalSubject = {
    type: subjType,
    lockToId: subjType === "none" ? "" : (subject.lockToId || ""),
    lockLabel: subjType === "none" ? "" : (subject.lockLabel || ""),
  };

  return {
    title: String(f.title || "").trim(),
    description: String(f.description || ""),
    formType: f.formType === "signoff" ? "signoff" : "standard",
    scope: {
      type: scope.type === "scoped" ? "scoped" : "global",
      projectId: scope.projectId || "",
      taskId: scope.taskId || "",
      milestoneId: scope.milestoneId || "",
      projectName: scope.projectName || "",
      taskName: scope.taskName || "",
      milestoneName: scope.milestoneName || "",
    },
    subject: finalSubject,
    rolesAllowed: Array.isArray(f.rolesAllowed)
      ? f.rolesAllowed
          .map((r) => String(r || "").trim().toLowerCase())
          .filter((r) => CANON_ROLES.includes(r))
      : [],
    items,
    scoring: { mode, maxNonCriticalFails, minPassPercent },
    isDeleted: !!f.isDeleted,
  };
}
