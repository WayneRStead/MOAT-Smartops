import React, { useEffect, useState } from "react";
import { api } from "../lib/api";

export default function VaultFilters({ value, onChange }) {
  const [folders, setFolders] = useState([]);
  const [tag, setTag] = useState(value?.tag || "");
  const [folder, setFolder] = useState(value?.folder || "");
  const [linkedTo, setLinkedTo] = useState(value?.linkedTo || ""); // e.g. "project:64a..."
  const [includeDeleted, setIncludeDeleted] = useState(!!value?.includeDeleted);
  const [q, setQ] = useState(value?.q || "");

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get("/documents/folders/list"); // optional; fallback below if 404
        setFolders(data || []);
      } catch {
        // fallback: derive folders from docs call if you prefer (skip here for brevity)
        setFolders([]);
      }
    })();
  }, []);

  useEffect(() => {
    onChange?.({ tag, folder, linkedTo, includeDeleted, q });
  }, [tag, folder, linkedTo, includeDeleted, q]);

  return (
    <div className="flex flex-wrap gap-2 items-center mb-3">
      <input className="border p-2" placeholder="Search…" value={q} onChange={e=>setQ(e.target.value)} />

      <input className="border p-2" placeholder="Tag" value={tag} onChange={e=>setTag(e.target.value)} />

      <select className="border p-2" value={folder} onChange={e=>setFolder(e.target.value)}>
        <option value="">Folder (any)</option>
        {folders.map(f => (
          <option key={f.folder || 'root'} value={f.folder || ""}>
            {(f.folder || "(root)")} {f.count ? `(${f.count})` : ""}
          </option>
        ))}
      </select>

      <input
        className="border p-2"
        placeholder='LinkedTo e.g. "project:64a..."'
        value={linkedTo}
        onChange={e=>setLinkedTo(e.target.value)}
        style={{ minWidth: 280 }}
      />

      <label className="flex items-center gap-2">
        <input type="checkbox" checked={includeDeleted} onChange={e=>setIncludeDeleted(e.target.checked)} />
        Include deleted
      </label>
    </div>
  );
}
