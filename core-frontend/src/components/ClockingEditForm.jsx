// src/components/ClockingEditForm.jsx
import React, { useMemo, useState } from "react";
import { api } from "../lib/api";

/** Helpers for <input type="datetime-local"> */
function toLocalInput(dtLike) {
  if (!dtLike) return "";
  const d = new Date(dtLike);
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60000);
  return local.toISOString().slice(0, 16);
}
function fromLocalInput(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export default function ClockingEditForm({
  clocking,
  users = [],
  projects = [],
  onSaved,
  onCancel,
}) {
  const [type, setType] = useState(clocking?.type || "present");
  const [at, setAt] = useState(() => toLocalInput(clocking?.at || new Date()));
  const [projectId, setProjectId] = useState(clocking?.projectId || "");
  const [notes, setNotes] = useState(clocking?.notes || "");
  const [editNote, setEditNote] = useState(""); // change reason
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  const projectOpts = useMemo(() => projects.map(p => ({ id: String(p._id), name: p.name || String(p._id) })), [projects]);

  async function onSubmit(e) {
    e?.preventDefault?.();
    setErr("");
    if (!editNote.trim()) {
      setErr("Please provide a Change Reason for the audit trail.");
      return;
    }
    try {
      setSaving(true);
      const payload = {
        type,
        at: fromLocalInput(at),
        projectId: projectId || undefined,
        notes: notes || "",
        editNote, // <- important for audit
      };
      await api.put(`/clockings/${clocking._id}`, payload);
      onSaved?.();
    } catch (e2) {
      setErr(e2?.response?.data?.error || String(e2));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      {err && <div className="text-red-600 text-sm">{err}</div>}

      <div className="grid md:grid-cols-2 gap-3">
        <label className="text-sm">
          Type
          <select
            className="border p-2 w-full"
            value={type}
            onChange={e => setType(e.target.value)}
          >
            {["present","in","out","training","sick","leave","iod","overtime"].map(t => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </label>

        <label className="text-sm">
          When
          <input
            className="border p-2 w-full"
            type="datetime-local"
            value={at}
            onChange={e => setAt(e.target.value)}
          />
        </label>

        <label className="text-sm">
          Project
          <select
            className="border p-2 w-full"
            value={projectId}
            onChange={e => setProjectId(e.target.value)}
          >
            <option value="">— none —</option>
            {projectOpts.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>

        <label className="text-sm">
          Notes
          <input
            className="border p-2 w-full"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Optional"
          />
        </label>
      </div>

      <label className="text-sm block">
        Change Reason (for audit)
        <input
          className="border p-2 w-full"
          value={editNote}
          onChange={e => setEditNote(e.target.value)}
          placeholder="Why are you changing this record?"
        />
      </label>

      <div className="flex items-center justify-end gap-2 pt-2">
        <button type="button" className="px-3 py-2 border rounded" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button className="px-3 py-2 bg-black text-white rounded" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}
