// src/pages/InspectionForms.jsx
import React, { useEffect, useState } from "react";
import { api } from "../lib/api";
import InspectionFormBuilder from "../components/InspectionFormBuilder.jsx";

function normalizeForm(t) {
  const _id = t._id || t.id;
  return {
    _id,
    name: t.name || t.title || "Inspection Form",
    active: t.active !== false,
    assignedProjectIds: Array.isArray(t.assignedProjectIds) ? t.assignedProjectIds.map(String)
      : Array.isArray(t.projects) ? t.projects.map(x=>String(x._id||x.id||x)) : [],
    assignedTaskIds: Array.isArray(t.assignedTaskIds) ? t.assignedTaskIds.map(String)
      : Array.isArray(t.tasks) ? t.tasks.map(x=>String(x._id||x.id||x)) : [],
  };
}

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

export default function InspectionForms() {
  const [forms, setForms] = useState([]);
  const [err, setErr] = useState("");
  const [editId, setEditId] = useState(null);

  async function reload() {
    setErr("");
    try { setForms(await loadAllForms()); }
    catch (e) { setErr(e?.response?.data?.error || e?.message || "Load failed"); }
  }
  useEffect(() => { reload(); }, []);

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Inspection Forms</h1>
        <button className="px-3 py-2 border rounded" onClick={()=>setEditId("new")}>
          New form
        </button>
      </div>

      {err && <div className="text-sm text-red-600">{err}</div>}

      <div className="border rounded overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50">
              <th className="p-2 text-left">Name</th>
              <th className="p-2 text-left">Active</th>
              <th className="p-2 text-left">Assigned projects</th>
              <th className="p-2 text-left">Assigned tasks</th>
              <th className="p-2 text-right">Edit</th>
            </tr>
          </thead>
          <tbody>
            {forms.length ? forms.map(f => (
              <tr key={f._id}>
                <td className="border-t p-2">{f.name}</td>
                <td className="border-t p-2">{f.active ? "Yes" : "No"}</td>
                <td className="border-t p-2">{f.assignedProjectIds.length}</td>
                <td className="border-t p-2">{f.assignedTaskIds.length}</td>
                <td className="border-t p-2 text-right">
                  <button className="px-2 py-1 border rounded" onClick={()=>setEditId(f._id)}>Edit</button>
                </td>
              </tr>
            )) : (
              <tr><td className="p-4 text-center text-gray-600" colSpan={5}>No forms yet</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {editId && (
        <InspectionFormBuilder
          formId={editId === "new" ? null : editId}
          onSaved={()=>{ setEditId(null); reload(); }}
          onDeleted={()=>{ setEditId(null); reload(); }}
        />
      )}
    </div>
  );
}
