// core-frontend/src/components/InspectionFormBuilder.jsx
import { useMemo, useEffect, useState } from 'react';
import RolesMultiSelect from './RolesMultiSelect.jsx';

const DEFAULT_FORM = {
  title: '',
  description: '',
  formType: 'standard', // 'standard' | 'signoff'
  scope: { type: 'global', projectId: '', taskId: '', milestoneId: '' },
  rolesAllowed: [],
  items: [],
};

const DEFAULT_ITEM = {
  label: '',
  allowPhoto: false,
  allowScan: false,
  allowNote: true,
  requireEvidenceOnFail: false,
  requireCorrectiveOnFail: true,
  criticalOnFail: false,
};

// ---------- EDIT THESE IF YOUR API PATHS DIFFER ----------
const ENDPOINTS = {
  projects: '/api/projects',
  // try tasks?projectId=... first; fallback to /api/projects/:id/tasks inside loader
  tasks: '/api/tasks',
  // try milestones?taskId=... first; fallback to /api/tasks/:id/milestones inside loader
  milestones: '/api/milestones',
  roles: '/api/users/roles',
};
// --------------------------------------------------------

function normalizeItem(it = {}) {
  return { ...DEFAULT_ITEM, ...it };
}

function normalizeForm(incoming) {
  const base = { ...DEFAULT_FORM, ...(incoming || {}) };
  base.scope = { ...DEFAULT_FORM.scope, ...(incoming?.scope || {}) };
  base.rolesAllowed = Array.isArray(incoming?.rolesAllowed) ? incoming.rolesAllowed : [];
  base.items = Array.isArray(incoming?.items) ? incoming.items.map(normalizeItem) : [];
  return base;
}

// Small helper so calls include auth + tenancy automatically
async function authedJsonGET(url, params) {
  const token = localStorage.getItem('token');
  const orgId = localStorage.getItem('orgId');
  const qs = params
    ? '?' +
      Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&')
    : '';
  const res = await fetch(url + qs, {
    method: 'GET',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(orgId ? { 'X-Org-Id': orgId } : {}),
    },
  });
  if (!res.ok) throw new Error(`GET ${url}${qs} -> ${res.status}`);
  return res.json();
}

// Cope with various backend shapes: {name} or {title} or {label}
function labelOf(obj) {
  return obj?.name || obj?.title || obj?.label || obj?._id || '';
}

export default function InspectionFormBuilder({ value, onChange }) {
  // Controlled by parent
  const form = useMemo(() => normalizeForm(value), [value]);

  // Option lists kept locally
  const [projects, setProjects] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [milestones, setMilestones] = useState([]);
  const [roles, setRoles] = useState([]);

  // Load roles + projects on mount (cached by browser; safe defaults if fails)
  useEffect(() => {
    (async () => {
      try {
        const r = await authedJsonGET(ENDPOINTS.roles);
        // roles could be [{key:'manager',name:'Manager'}] or simple strings; normalize to strings
        const norm =
          Array.isArray(r) && r.length
            ? r
                .map((x) =>
                  typeof x === 'string'
                    ? x
                    : x.key || x.name || x.title || x.label
                )
                .filter(Boolean)
            : ['user', 'group-leader', 'project-manager', 'manager', 'admin', 'superadmin'];
        setRoles(Array.from(new Set(norm)));
      } catch {
        setRoles(['user', 'group-leader', 'project-manager', 'manager', 'admin', 'superadmin']);
      }

      try {
        const p = await authedJsonGET(ENDPOINTS.projects);
        setProjects(Array.isArray(p) ? p : []);
      } catch {
        setProjects([]);
      }
    })();
  }, []);

  // Load tasks when project changes (also clears milestones)
  useEffect(() => {
    (async () => {
      if (form.scope?.type !== 'scoped' || !form.scope?.projectId) {
        setTasks([]);
        setMilestones([]);
        return;
      }
      try {
        // Prefer /api/tasks?projectId=...
        const t = await authedJsonGET(ENDPOINTS.tasks, { projectId: form.scope.projectId });
        setTasks(Array.isArray(t) ? t : []);
      } catch {
        // Fallback /api/projects/:id/tasks
        try {
          const t2 = await authedJsonGET(`${ENDPOINTS.projects}/${form.scope.projectId}/tasks`);
          setTasks(Array.isArray(t2) ? t2 : []);
        } catch {
          setTasks([]);
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.scope?.type, form.scope?.projectId]);

// Load milestones when task changes
useEffect(() => {
  (async () => {
    if (form.scope?.type !== 'scoped' || !form.scope?.taskId) {
      setMilestones([]);
      return;
    }
    // ✅ Try the nested route first to avoid 404 noise
    try {
      const m2 = await authedJsonGET(`${ENDPOINTS.tasks}/${form.scope.taskId}/milestones`);
      setMilestones(Array.isArray(m2) ? m2 : []);
      return;
    } catch {
      // ignore and try the query-style endpoint as a fallback
    }
    try {
      const m = await authedJsonGET(ENDPOINTS.milestones, { taskId: form.scope.taskId });
      setMilestones(Array.isArray(m) ? m : []);
    } catch {
      setMilestones([]);
    }
  })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [form.scope?.type, form.scope?.taskId]);

  // ---- push patches to parent (no effects calling onChange) ----
  const update = (patch) => onChange?.({ ...form, ...patch });
  const updateScope = (patch) => onChange?.({ ...form, scope: { ...form.scope, ...patch } });

  const addItem = () => onChange?.({ ...form, items: [...form.items, { ...DEFAULT_ITEM }] });
  const updateItem = (idx, patch) => {
    const items = form.items.map((it, i) => (i === idx ? normalizeItem({ ...it, ...patch }) : it));
    onChange?.({ ...form, items });
  };
  const removeItem = (idx) => onChange?.({ ...form, items: form.items.filter((_, i) => i !== idx) });
  const moveItem = (from, to) => {
    if (to < 0 || to >= form.items.length) return;
    const items = form.items.slice();
    const [spliced] = items.splice(from, 1);
    items.splice(to, 0, spliced);
    onChange?.({ ...form, items });
  };

  // Handlers for cascaded selects (clear children in the same update)
  const handleScopeType = (nextType) => {
    if (nextType === 'global') {
      updateScope({ type: 'global', projectId: '', taskId: '', milestoneId: '' });
    } else {
      updateScope({ type: 'scoped' });
    }
  };
  const handleProject = (pid) => {
    updateScope({ projectId: pid || '', taskId: '', milestoneId: '' });
  };
  const handleTask = (tid) => {
    updateScope({ taskId: tid || '', milestoneId: '' });
  };
  const handleMilestone = (mid) => {
    updateScope({ milestoneId: mid || '' });
  };

  return (
    <div className="space-y-6">
      {/* Title / Type */}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="font-medium">Form title</span>
          <input
            className="mt-1 input input-bordered w-full"
            value={form.title}
            onChange={(e) => update({ title: e.target.value })}
            placeholder="e.g., Daily Site Safety"
          />
        </label>
        <label className="block">
          <span className="font-medium">Form type</span>
          <select
            className="mt-1 select select-bordered w-full"
            value={form.formType}
            onChange={(e) => update({ formType: e.target.value })}
          >
            <option value="standard">Standard</option>
            <option value="signoff">Sign-off</option>
          </select>
        </label>
      </div>

      {/* Description */}
      <div>
        <span className="font-medium">Description (optional)</span>
        <textarea
          className="mt-1 textarea textarea-bordered w-full"
          rows={3}
          value={form.description}
          onChange={(e) => update({ description: e.target.value })}
          placeholder="Short description shown to inspectors…"
        />
      </div>

      {/* Scope (same pattern as Form type: a select) */}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="font-medium">Scope</span>
          <select
            className="mt-1 select select-bordered w-full"
            value={form.scope?.type || 'global'}
            onChange={(e) => handleScopeType(e.target.value)}
          >
            <option value="global">Global (seen everywhere)</option>
            <option value="scoped">Assign to project/task/milestone/roles</option>
          </select>
        </label>

        {/* Roles (optional) – professional multi-select */}
        <div className="block">
          <span className="font-medium">Roles (optional)</span>
          <p className="text-xs text-gray-500">If empty, any role may use the form.</p>
          <div className="mt-2">
            <RolesMultiSelect
              options={roles}
              value={form.rolesAllowed}
              onChange={(next) => onChange?.({ ...form, rolesAllowed: next })}
            />
          </div>
        </div>
      </div>

      {/* Scoped selects (only visible when scoped) */}
      {form.scope?.type === 'scoped' && (
        <div className="grid gap-3 sm:grid-cols-3">
          {/* Project */}
          <label className="block">
            <span className="font-medium">Project</span>
            <select
              className="mt-1 select select-bordered w-full"
              value={form.scope?.projectId || ''}
              onChange={(e) => handleProject(e.target.value)}
            >
              <option value="">- Select project -</option>
              {projects.map((p) => (
                <option key={p._id || p.id} value={p._id || p.id}>
                  {labelOf(p)}
                </option>
              ))}
            </select>
          </label>

          {/* Task */}
          <label className="block">
            <span className="font-medium">Task (optional)</span>
            <select
              className="mt-1 select select-bordered w-full"
              value={form.scope?.taskId || ''}
              onChange={(e) => handleTask(e.target.value)}
              disabled={!form.scope?.projectId}
            >
              <option value="">- Any task -</option>
              {tasks.map((t) => (
                <option key={t._id || t.id} value={t._id || t.id}>
                  {labelOf(t)}
                </option>
              ))}
            </select>
          </label>

          {/* Milestone */}
          <label className="block">
            <span className="font-medium">Milestone (optional)</span>
            <select
              className="mt-1 select select-bordered w-full"
              value={form.scope?.milestoneId || ''}
              onChange={(e) => handleMilestone(e.target.value)}
              disabled={!form.scope?.taskId}
            >
              <option value="">- Any milestone -</option>
              {milestones.map((m) => (
                <option key={m._id || m.id} value={m._id || m.id}>
                  {labelOf(m)}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {/* Items */}
      <div>
        <div className="flex items-center justify-between">
          <span className="font-medium">Items</span>
          <button type="button" className="btn btn-primary btn-sm" onClick={addItem}>
            + Add item
          </button>
        </div>

        <div className="mt-3 space-y-3">
          {(form.items || []).map((it, idx) => (
            <div key={idx} className="rounded-xl border p-3 space-y-3">
              {/* Header with label + reorder */}
              <div className="flex items-center gap-2">
                <input
                  className="input input-bordered flex-1"
                  placeholder={`Item ${idx + 1} label…`}
                  value={it.label}
                  onChange={(e) => updateItem(idx, { label: e.target.value })}
                />
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs"
                    onClick={() => moveItem(idx, idx - 1)}
                    title="Move up"
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs"
                    onClick={() => moveItem(idx, idx + 1)}
                    title="Move down"
                  >
                    ▼
                  </button>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => removeItem(idx)}
                >
                  Remove
                </button>
              </div>

              {/* Attachment toggles (Photo / Scan / Extra Text) */}
              <div className="grid gap-2 sm:grid-cols-3">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={!!it.allowPhoto}
                    onChange={(e) => updateItem(idx, { allowPhoto: e.target.checked })}
                  />
                  Photo
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={!!it.allowScan}
                    onChange={(e) => updateItem(idx, { allowScan: e.target.checked })}
                  />
                  Scan
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={!!it.allowNote}
                    onChange={(e) => updateItem(idx, { allowNote: e.target.checked })}
                  />
                  Extra Text
                </label>
              </div>

              {/* Fail requires evidence / Critical fail */}
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={!!it.requireEvidenceOnFail}
                    onChange={(e) =>
                      updateItem(idx, { requireEvidenceOnFail: e.target.checked })
                    }
                  />
                  Fail requires evidence
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={!!it.criticalOnFail}
                    onChange={(e) => updateItem(idx, { criticalOnFail: e.target.checked })}
                  />
                  Critical fail (auto-fail form)
                </label>
              </div>

              {/* Require corrective action on fail */}
              <div>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={!!it.requireCorrectiveOnFail}
                    onChange={(e) =>
                      updateItem(idx, { requireCorrectiveOnFail: e.target.checked })
                    }
                  />
                  Require “Corrective Action” on fail
                </label>
              </div>

              <p className="text-xs text-gray-500">
                Attachments are available in the runner when enabled; they become required only if
                the item is marked <strong>Fail</strong> (per settings).
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
