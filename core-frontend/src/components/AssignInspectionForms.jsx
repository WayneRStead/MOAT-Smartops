// src/components/AssignInspectionForms.jsx
import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";

const idOf = (x) => (typeof x === "string" ? x : (x?._id || x?.id || ""));

function normalizeForm(t) {
  if (!t) return t;
  return {
    _id: t._id || t.id,
    name: t.name || t.title || "Inspection Form",
    active: t.active !== false,
    assignedProjectIds: Array.isArray(t.assignedProjectIds) ? t.assignedProjectIds.map(String)
      : Array.isArray(t.projects) ? t.projects.map(idOf) : [],
    assignedTaskIds: Array.isArray(t.assignedTaskIds) ? t.assignedTaskIds.map(String)
      : Array.isArray(t.tasks) ? t.tasks.map(idOf) : [],
  };
}

/* ---- API helpers ---- */
async function loadAllForms() {
  try {
    const r = await api.get(`/inspection-templates`, { params: { limit: 1000 } });
    const arr = Array.isArray(r.data) ? r.data
      : Array.isArray(r.data?.items) ? r.data.items
      : Array.isArray(r.data?.templates) ? r.data.templates : [];
    return arr.map(normalizeForm);
  } catch {
    const r2 = await api.get(`/templates`, { params: { kind: "inspection", limit: 1000 } });
    const arr2 = Array.isArray(r2.data) ? r2.data : (Array.isArray(r2.data?.items) ? r2.data.items : []);
    return arr2.map(normalizeForm);
  }
}

async function getAssigned(kind, id) {
  try {
    const r = await api.get(`/${kind}/${id}/inspection-templates`);
    const arr = Array.isArray(r.data) ? r.data
      : Array.isArray(r.data?.items) ? r.data.items
      : Array.isArray(r.data?.templates) ? r.data.templates : [];
    return arr.map(normalizeForm).map(f => f._id);
  } catch {
    return null; // signal to client-side derive
  }
}
async function saveAssigned(kind, id, formIds) {
  // Preferred: PUT full set
  try {
    await api.put(`/${kind}/${id}/inspection-templates`, { formIds });
    return true;
  } catch (e) {
    // Fallback: patch forms' assignment arrays client-side
    await Promise.all(formIds.map(fid =>
      api.patch(`/inspection-templates/${fid}`, kind === "projects"
        ? { $addToSet: { assignedProjectIds: id } }
        : { $addToSet: { assignedTaskIds: id } }
      ).catch(async () => {
        await api.patch(`/templates/${fid}`, kind === "projects"
          ? { $addToSet: { assignedProjectIds: id } }
          : { $addToSet: { assignedTaskIds: id } }
        );
      })
    ));
    return true;
  }
}

export default function AssignInspectionForms({ projectId=null, taskId=null }) {
  const kind = projectId ? "projects" : (taskId ? "tasks" : null);
  const holderId = String(projectId || taskId || "");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [forms, setForms] = useState([]);
  const [selected, setSelected] = useState(new Set());

  useEffect(() => {
    (async () => {
      setErr(""); setLoading(true);
      try {
        const all = await loadAllForms();
        // try server-scoped assignment
        let assignedIds = holderId ? await getAssigned(kind, holderId) : null;

        // If server didn't return scoped list, derive from form assignment arrays
        if (!assignedIds && holderId) {
          const mine = kind === "projects"
            ? all.filter(f => f.assignedProjectIds.includes(holderId)).map(f => f._id)
            : all.filter(f => f.assignedTaskIds.includes(holderId)).map(f => f._id);
          assignedIds = mine;
        }

        setForms(all.filter(f => f.active)); // only active forms are assignable
        setSelected(new Set((assignedIds || []).map(String)));
      } catch (e) { setErr(e?.response?.data?.error || e?.message || "Load failed"); }
      finally { setLoading(false); }
    })();
  }, [kind, holderId]);

  function toggle(fid) {
    const id = String(fid);
    setSelected(s => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function save() {
    if (!holderId || !kind) return;
    setErr(""); setLoading(true);
    try {
      await saveAssigned(kind, holderId, Array.from(selected));
    } catch (e) { setErr(e?.response?.data?.error || e?.message || "Save failed"); }
    finally { setLoading(false); }
  }

  if (!kind || !holderId) return null;

  return (
    <div className="border rounded p-3 space-y-2">
      <div className="font-semibold">Inspection forms assigned to this {projectId ? "project" : "task"}</div>
      {err && <div className="text-sm text-red-600">{err}</div>}
      {loading && <div className="text-sm text-gray-600">Loading…</div>}

      <div className="grid md:grid-cols-2 gap-2">
        {forms.map(f => (
          <label key={f._id} className="border rounded p-2 flex items-center gap-2">
            <input
              type="checkbox"
              checked={selected.has(String(f._id))}
              onChange={()=>toggle(f._id)}
            />
            <div>
              <div className="font-medium text-sm">{f.name}</div>
              <div className="text-xs text-gray-600">id: {f._id}</div>
            </div>
          </label>
        ))}
        {!forms.length && <div className="text-sm text-gray-600 md:col-span-2">No active forms. Create one below.</div>}
      </div>

      <div className="flex gap-2">
        <button className="px-3 py-2 border rounded" onClick={save} type="button">Save assignments</button>
      </div>
    </div>
  );
}
