// src/pages/Vault.jsx
import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";

/** --- filetype helpers --- **/
function guessMimeFromName(name = "") {
  const ext = String(name).toLowerCase().split(".").pop();
  const map = {
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    mp4: "video/mp4",
    webm: "video/webm",
    ogg: "video/ogg",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    txt: "text/plain",
    csv: "text/csv",
    json: "application/json",
    md: "text/markdown",
    html: "text/html",
  };
  return map[ext] || "";
}
function isPreviewable(mime = "") {
  const m = mime.toLowerCase();
  return (
    m.startsWith("image/") ||
    m.startsWith("video/") ||
    m.startsWith("audio/") ||
    m === "application/pdf" ||
    m.startsWith("text/") ||
    /\/(json|csv)$/.test(m)
  );
}
function isTextLike(mime = "") {
  const m = mime.toLowerCase();
  return m.startsWith("text/") || /\/(json|csv)$/.test(m);
}

/** --- small UI helpers --- **/
function TagOrDash({ value }) {
  return value?.length ? value.join(", ") : <span className="muted">—</span>;
}
function Dash({ value }) {
  return value ? value : <span className="muted">—</span>;
}

export default function Vault() {
  const [docs, setDocs] = useState([]);
  const [q, setQ] = useState("");
  const [includeDeleted, setIncludeDeleted] = useState(false);

  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");

  const [creating, setCreating] = useState({ title: "", folder: "", tags: "" });
  const [pendingFile, setPendingFile] = useState({}); // { [id]: File|null }

  // preview modal state
  const [previewDoc, setPreviewDoc] = useState(null); // a full doc row
  const [pvLoading, setPvLoading] = useState(false);
  const [pvErr, setPvErr] = useState("");
  const [pvUrl, setPvUrl] = useState(""); // object URL for media/pdf
  const [pvText, setPvText] = useState(""); // text preview (for text/*)

  async function load() {
    setErr(""); setInfo("");
    try {
      const params = {};
      if (q) params.q = q;
      if (includeDeleted) params.includeDeleted = 1;
      const { data } = await api.get("/documents", { params });
      setDocs(data || []);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [includeDeleted]);

  async function doCreate(e) {
    e.preventDefault();
    setErr(""); setInfo("");
    const body = {
      title: (creating.title || "").trim(),
      folder: (creating.folder || "").trim(),
      tags: (creating.tags || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    };
    if (!body.title) return setErr("Title required");
    try {
      const { data: doc } = await api.post("/documents", body);
      setDocs((prev) => [doc, ...prev]);
      setCreating({ title: "", folder: "", tags: "" });
      setInfo("Document created. You can upload a version.");
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  async function doUpload(id) {
    const f = pendingFile[id];
    if (!f) return;
    setErr(""); setInfo("");
    try {
      const fd = new FormData();
      fd.append("file", f);
      const { data: updated } = await api.post(`/documents/${id}/upload`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setDocs((prev) => prev.map((d) => (d._id === id ? updated : d)));
      setPendingFile((p) => ({ ...p, [id]: null }));
      setInfo("Version uploaded.");
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  async function doRename(id, title) {
    try {
      const { data: updated } = await api.put(`/documents/${id}`, { title });
      setDocs((prev) => prev.map((d) => (d._id === id ? updated : d)));
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  async function doDelete(id) {
    if (!confirm("Delete this document?")) return;
    try {
      await api.delete(`/documents/${id}`);
      await load();
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  async function doRestore(id) {
    try {
      const { data: restored } = await api.patch(`/documents/${id}/restore`);
      setDocs((prev) => prev.map((d) => (d._id === id ? restored : d)));
      setInfo("Document restored.");
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  // ---------- Preview handling ----------
  // We will fetch the latest file URL as a Blob and render it inline.
  // This avoids forced download headers because we're using an object URL.
  async function openPreview(doc) {
    setPreviewDoc(doc);
    setPvErr("");
    setPvText("");
    setPvUrl("");
    const url = doc?.latest?.url;
    const filename = doc?.latest?.filename || doc?.title || "document";
    const declaredMime = doc?.latest?.mime || guessMimeFromName(filename);

    if (!url) {
      setPvErr("No file uploaded yet.");
      return;
    }

    if (!isPreviewable(declaredMime)) {
      setPvErr("Preview for this file type isn’t supported. Use Download to open it.");
      return;
    }

    setPvLoading(true);
    try {
      // Use fetch to get a blob, then build an object URL we control.
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`Failed to load file (${res.status})`);
      const ct = res.headers.get("content-type") || declaredMime || "application/octet-stream";
      if (isTextLike(ct)) {
        // Show text content in the modal
        const text = await res.text();
        setPvText(text);
      } else {
        const blob = await res.blob();
        const objUrl = URL.createObjectURL(blob);
        setPvUrl(objUrl);
      }
    } catch (e) {
      setPvErr(e?.message || "Failed to preview file.");
    } finally {
      setPvLoading(false);
    }
  }

  function closePreview() {
    if (pvUrl) {
      try { URL.revokeObjectURL(pvUrl); } catch {}
    }
    setPreviewDoc(null);
    setPvUrl("");
    setPvText("");
    setPvErr("");
  }

  const previewMime = useMemo(() => {
    if (!previewDoc) return "";
    return (
      previewDoc?.latest?.mime ||
      guessMimeFromName(previewDoc?.latest?.filename || previewDoc?.title || "")
    );
  }, [previewDoc]);

  const isPdf   = useMemo(() => previewMime === "application/pdf", [previewMime]);
  const isImage = useMemo(() => previewMime.startsWith("image/"), [previewMime]);
  const isVideo = useMemo(() => previewMime.startsWith("video/"), [previewMime]);
  const isAudio = useMemo(() => previewMime.startsWith("audio/"), [previewMime]);
  const textLike = useMemo(() => isTextLike(previewMime), [previewMime]);

  return (
    <div className="card">
      <h2>Smart Document Vault</h2>
      {err && <p style={{ color: "crimson" }}>{err}</p>}
      {info && <p style={{ color: "seagreen" }}>{info}</p>}

      {/* Search & options */}
      <div className="row" style={{ gap: 8, marginBottom: 12, alignItems: "center" }}>
        <input
          placeholder="Search title / filename / tag…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && load()}
          style={{ minWidth: 280 }}
        />
        <button onClick={load}>Search</button>

        <label style={{ display: "flex", gap: 6, alignItems: "center", marginLeft: 12 }}>
          <input
            type="checkbox"
            checked={includeDeleted}
            onChange={(e) => setIncludeDeleted(e.target.checked)}
          />
          Include deleted
        </label>
      </div>

      {/* Create */}
      <form
        className="row"
        onSubmit={doCreate}
        style={{ gap: 8, marginBottom: 16, alignItems: "end" }}
      >
        <label>
          Title
          <input
            value={creating.title}
            onChange={(e) => setCreating({ ...creating, title: e.target.value })}
            required
          />
        </label>
        <label>
          Folder
          <input
            value={creating.folder}
            onChange={(e) => setCreating({ ...creating, folder: e.target.value })}
            placeholder="Policies/Health & Safety"
          />
        </label>
        <label>
          Tags
          <input
            value={creating.tags}
            onChange={(e) => setCreating({ ...creating, tags: e.target.value })}
            placeholder="safety, onboarding"
          />
        </label>
        <button className="btn-primary">Add</button>
      </form>

      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 260 }}>Title</th>
            <th>Latest</th>
            <th>Tags</th>
            <th>Folder</th>
            <th>Updated</th>
            <th>Upload</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {docs.map((d) => (
            <tr key={d._id} className={d.deletedAt ? "opacity-60" : ""}>
              <td>
                <input
                  value={d.title || ""}
                  onChange={(e) =>
                    setDocs((prev) =>
                      prev.map((x) => (x._id === d._id ? { ...x, title: e.target.value } : x))
                    )
                  }
                  onBlur={(e) => {
                    const newTitle = (e.target.value || "").trim();
                    if (newTitle && newTitle !== d.title) doRename(d._id, newTitle);
                  }}
                />
                {d.deletedAt && (
                  <div style={{ fontSize: 12, color: "#a00" }}>
                    deleted {new Date(d.deletedAt).toLocaleString()}
                  </div>
                )}
              </td>
              <td>
                {d.latest ? (
                  <div className="row" style={{ gap: 8, alignItems: "center" }}>
                    <button
                      className="btn"
                      type="button"
                      onClick={() => openPreview(d)}
                      title="Preview in app"
                    >
                      Preview
                    </button>
                    <a
                      className="btn"
                      href={d.latest.url}
                      target="_blank"
                      rel="noreferrer"
                      title="Download file"
                    >
                      Download
                    </a>
                    <span className="muted" title={d.latest.filename} style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {d.latest.filename}
                    </span>
                  </div>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td><TagOrDash value={d.tags} /></td>
              <td><Dash value={d.folder} /></td>
              <td>{new Date(d.updatedAt || d.createdAt).toLocaleString()}</td>
              <td>
                {!d.deletedAt ? (
                  <div className="row" style={{ gap: 6 }}>
                    <input
                      type="file"
                      onChange={(e) =>
                        setPendingFile((p) => ({
                          ...p,
                          [d._id]: e.target.files?.[0] || null,
                        }))
                      }
                    />
                    <button onClick={() => doUpload(d._id)} disabled={!pendingFile[d._id]}>
                      Upload
                    </button>
                  </div>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td>
                {!d.deletedAt ? (
                  <button onClick={() => doDelete(d._id)}>Delete</button>
                ) : (
                  <button onClick={() => doRestore(d._id)}>Restore</button>
                )}
              </td>
            </tr>
          ))}
          {!docs.length && (
            <tr>
              <td colSpan={7} style={{ opacity: 0.7 }}>
                No documents yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {/* Preview Modal */}
      {previewDoc && (
        <div
          className="fixed inset-0"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 200,
            padding: 12,
          }}
        >
          <div
            className="bg-white rounded shadow-2xl"
            style={{ width: "100%", maxWidth: 1000, maxHeight: "90vh", display: "flex", flexDirection: "column" }}
          >
            {/* header */}
            <div className="row" style={{ justifyContent: "space-between", padding: 12, borderBottom: "1px solid #eee", alignItems: "center" }}>
              <div style={{ minWidth: 0 }}>
                <div className="font-medium" title={previewDoc.latest?.filename || previewDoc.title}>
                  {previewDoc.title || previewDoc.latest?.filename || "Document"}
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  Type: {previewMime || "unknown"}
                </div>
              </div>
              <div className="row" style={{ gap: 8 }}>
                {previewDoc?.latest?.url && (
                  <a className="btn" href={previewDoc.latest.url} target="_blank" rel="noreferrer">Download</a>
                )}
                <button className="btn" onClick={closePreview}>Close</button>
              </div>
            </div>

            {/* body */}
            <div style={{ flex: 1, overflow: "auto", background: "#f7f7f7" }}>
              {pvLoading && <div style={{ padding: 16, fontSize: 14, color: "#555" }}>Loading preview…</div>}
              {pvErr && <div style={{ padding: 16, color: "crimson" }}>{pvErr}</div>}

              {!pvLoading && !pvErr && (
                <>
                  {textLike && (
                    <div style={{ padding: 12 }}>
                      <pre
                        style={{
                          whiteSpace: "pre-wrap",
                          background: "white",
                          border: "1px solid #eee",
                          borderRadius: 6,
                          padding: 12,
                          maxHeight: "75vh",
                          overflow: "auto",
                          fontSize: 12,
                        }}
                      >
                        {pvText || "(empty file)"}
                      </pre>
                    </div>
                  )}

                  {isImage && pvUrl && (
                    <div style={{ padding: 12, display: "flex", justifyContent: "center" }}>
                      <img
                        src={pvUrl}
                        alt={previewDoc.latest?.filename || previewDoc.title}
                        style={{ maxWidth: "100%", maxHeight: "75vh", objectFit: "contain", borderRadius: 6, background: "white" }}
                      />
                    </div>
                  )}

                  {isVideo && pvUrl && (
                    <div style={{ padding: 12 }}>
                      <video src={pvUrl} controls style={{ width: "100%", maxHeight: "75vh", background: "black" }} />
                    </div>
                  )}

                  {isAudio && pvUrl && (
                    <div style={{ padding: 12 }}>
                      <audio src={pvUrl} controls style={{ width: "100%" }} />
                    </div>
                  )}

                  {isPdf && pvUrl && (
                    <div style={{ height: "75vh" }}>
                      <iframe title="PDF preview" src={pvUrl} style={{ width: "100%", height: "100%", border: 0 }} />
                    </div>
                  )}

                  {!textLike && !isImage && !isVideo && !isAudio && !isPdf && (
                    <div style={{ padding: 16, fontSize: 14, color: "#555" }}>
                      Preview not available. Use <b>Download</b> to open the file.
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
