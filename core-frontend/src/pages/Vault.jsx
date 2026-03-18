import { useEffect, useMemo, useState } from "react";
import { api, fileUrl } from "../lib/api";

const MOBILE_FOLDER_OPTIONS = ["policies", "safety", "general"];
const VAULT_CHANNEL_OPTIONS = ["mobile-library", "vault-only"];

const docIdOf = (d) => (d && (d._id || d.id) ? String(d._id || d.id) : "");

function guessMimeFromName(name = "") {
  const ext = String(name).toLowerCase().split(".").pop();
  const map = {
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    tiff: "image/tiff",
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
  const m = String(mime || "").toLowerCase();
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
  const m = String(mime || "").toLowerCase();
  return m.startsWith("text/") || /\/(json|csv)$/.test(m);
}

function normalizeChannel(v) {
  return String(v || "")
    .trim()
    .toLowerCase() === "mobile-library"
    ? "mobile-library"
    : "vault-only";
}

function normalizeFolder(v, channel) {
  const safeChannel = normalizeChannel(channel);
  const safeFolder = String(v || "")
    .trim()
    .toLowerCase();
  if (safeChannel !== "mobile-library") return "";
  return MOBILE_FOLDER_OPTIONS.includes(safeFolder) ? safeFolder : "";
}

function TagOrDash({ value }) {
  return value?.length ? (
    value.join(", ")
  ) : (
    <span className="text-gray-500">—</span>
  );
}

function Dash({ value }) {
  return value ? value : <span className="text-gray-500">—</span>;
}

function Modal({ open, onClose, children, title, width = 760 }) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[200]"
      onMouseDown={onClose}
      style={{
        background: "rgba(0,0,0,0.45)",
        display: "grid",
        placeItems: "center",
        padding: 16,
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="bg-white rounded-2xl shadow-2xl"
        style={{
          width,
          maxWidth: "95vw",
          maxHeight: "90vh",
          overflow: "auto",
        }}
      >
        <div className="flex items-center justify-between p-4 border-b">
          <h3 className="text-lg font-semibold m-0">{title}</h3>
          <button className="text-xl" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

export default function Vault() {
  const [docs, setDocs] = useState([]);
  const [q, setQ] = useState("");
  const [qDeb, setQDeb] = useState("");
  const [includeDeleted, setIncludeDeleted] = useState(false);

  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");

  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState({
    title: "",
    channel: "vault-only",
    folder: "",
    tags: "",
  });
  const [createFile, setCreateFile] = useState(null);
  const [createSaving, setCreateSaving] = useState(false);

  const [editDoc, setEditDoc] = useState(null);
  const [editTitle, setEditTitle] = useState("");
  const [editChannel, setEditChannel] = useState("vault-only");
  const [editFolder, setEditFolder] = useState("");
  const [editFile, setEditFile] = useState(null);
  const [editSaving, setEditSaving] = useState(false);

  const [previewDoc, setPreviewDoc] = useState(null);
  const [pvLoading, setPvLoading] = useState(false);
  const [pvErr, setPvErr] = useState("");
  const [pvUrl, setPvUrl] = useState("");
  const [pvText, setPvText] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setQDeb(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  async function load() {
    setErr("");
    setInfo("");
    try {
      const params = {};
      if (qDeb) params.q = qDeb;
      if (includeDeleted) params.includeDeleted = 1;
      const { data } = await api.get("/documents", { params });
      setDocs(Array.isArray(data) ? data : []);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeDeleted, qDeb]);

  async function doRename(id, title) {
    const safeId = String(id || "");
    if (!safeId) return;

    try {
      const { data: updated } = await api.put(
        `/documents/${encodeURIComponent(safeId)}`,
        { title },
      );
      setDocs((prev) => prev.map((d) => (docIdOf(d) === safeId ? updated : d)));
      setInfo("Title updated.");
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  async function doUploadVersion(id, file) {
    const safeId = String(id || "");
    if (!safeId || !file) return;

    try {
      const fd = new FormData();
      fd.append("file", file);

      const { data: updated } = await api.post(
        `/documents/${encodeURIComponent(safeId)}/upload`,
        fd,
        {
          headers: { "Content-Type": "multipart/form-data" },
        },
      );

      setDocs((prev) => prev.map((d) => (docIdOf(d) === safeId ? updated : d)));
      setInfo("Version uploaded.");
      return updated;
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
      throw e;
    }
  }

  async function doCreate(e) {
    e.preventDefault();
    setErr("");
    setInfo("");
    setCreateSaving(true);

    const safeChannel = normalizeChannel(creating.channel);
    const safeFolder = normalizeFolder(creating.folder, safeChannel);

    const body = {
      title: String(creating.title || "").trim(),
      channel: safeChannel,
      folder: safeFolder,
      tags: String(creating.tags || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    };

    if (!body.title) {
      setCreateSaving(false);
      setErr("Title required");
      return;
    }

    if (body.channel === "mobile-library" && !body.folder) {
      setCreateSaving(false);
      setErr(
        "Mobile library documents must use folder: policies, safety, or general.",
      );
      return;
    }

    try {
      const { data: doc } = await api.post("/documents", body);

      let finalDoc = doc;
      if (createFile) {
        finalDoc = await doUploadVersion(docIdOf(doc), createFile);
      }

      setDocs((prev) => [finalDoc, ...prev]);
      setCreating({
        title: "",
        channel: "vault-only",
        folder: "",
        tags: "",
      });
      setCreateFile(null);
      setShowCreate(false);

      setInfo(
        createFile
          ? "Document created and file uploaded."
          : "Document created.",
      );
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    } finally {
      setCreateSaving(false);
    }
  }

  async function doDelete(id) {
    const safeId = String(id || "");
    if (!safeId) return;
    if (!window.confirm("Delete this document?")) return;

    try {
      await api.delete(`/documents/${encodeURIComponent(safeId)}`);
      await load();
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  async function doHardDelete(id) {
    const safeId = String(id || "");
    if (!safeId) return;

    if (
      !window.confirm(
        "Permanently delete this document and all its versions? This cannot be undone.",
      )
    ) {
      return;
    }

    try {
      await api.delete(`/documents/${encodeURIComponent(safeId)}`, {
        params: { hard: 1 },
      });
      await load();
      setInfo("Document permanently deleted.");
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  async function doRestore(id) {
    const safeId = String(id || "");
    if (!safeId) return;

    try {
      const { data: restored } = await api.patch(
        `/documents/${encodeURIComponent(safeId)}/restore`,
      );
      setDocs((prev) =>
        prev.map((d) => (docIdOf(d) === safeId ? restored : d)),
      );
      setInfo("Document restored.");
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  async function openPreview(doc) {
    setPreviewDoc(doc);
    setPvErr("");
    setPvText("");

    if (pvUrl) {
      try {
        URL.revokeObjectURL(pvUrl);
      } catch {}
    }
    setPvUrl("");

    const rawUrl = doc?.latest?.url;
    const absUrl = rawUrl ? fileUrl(rawUrl) : "";
    const filename = doc?.latest?.filename || doc?.title || "document";
    const declaredMime = doc?.latest?.mime || guessMimeFromName(filename);

    if (!rawUrl) {
      setPvErr("No file uploaded yet.");
      return;
    }

    if (!isPreviewable(declaredMime)) {
      setPvErr(
        "Preview for this file type isn’t supported. Use Download in the preview.",
      );
      return;
    }

    setPvLoading(true);
    try {
      const res = await fetch(absUrl, { credentials: "include" });
      if (!res.ok) throw new Error(`Failed to load file (${res.status})`);

      const ct =
        res.headers.get("content-type") ||
        declaredMime ||
        "application/octet-stream";

      if (isTextLike(ct)) {
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
      try {
        URL.revokeObjectURL(pvUrl);
      } catch {}
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

  const isPdf = useMemo(() => previewMime === "application/pdf", [previewMime]);
  const isImage = useMemo(
    () => previewMime.startsWith("image/"),
    [previewMime],
  );
  const isVideo = useMemo(
    () => previewMime.startsWith("video/"),
    [previewMime],
  );
  const isAudio = useMemo(
    () => previewMime.startsWith("audio/"),
    [previewMime],
  );
  const textLike = useMemo(() => isTextLike(previewMime), [previewMime]);

  function openEditModal(doc) {
    const currentChannel = normalizeChannel(doc?.channel || "vault-only");
    const currentFolder = normalizeFolder(doc?.folder || "", currentChannel);

    setEditDoc(doc);
    setEditTitle(doc?.title || "");
    setEditChannel(currentChannel);
    setEditFolder(
      currentChannel === "mobile-library" ? currentFolder || "policies" : "",
    );
    setEditFile(null);
    setEditSaving(false);
  }

  function closeEditModal() {
    setEditDoc(null);
    setEditTitle("");
    setEditChannel("vault-only");
    setEditFolder("");
    setEditFile(null);
    setEditSaving(false);
  }

  async function saveEditModal() {
    if (!editDoc) return;

    setEditSaving(true);
    setErr("");
    setInfo("");

    try {
      const id = docIdOf(editDoc);
      const trimmedTitle = String(editTitle || "").trim();
      const safeChannel = normalizeChannel(editChannel);
      const safeFolder = normalizeFolder(editFolder, safeChannel);

      if (!trimmedTitle) {
        throw new Error("Title required");
      }

      if (safeChannel === "mobile-library" && !safeFolder) {
        throw new Error(
          "Mobile library documents must use folder: policies, safety, or general.",
        );
      }

      const { data: updated } = await api.put(
        `/documents/${encodeURIComponent(id)}`,
        {
          title: trimmedTitle,
          channel: safeChannel,
          folder: safeFolder,
        },
      );

      setDocs((prev) => prev.map((d) => (docIdOf(d) === id ? updated : d)));
      setEditDoc(updated);

      if (editFile) {
        await doUploadVersion(id, editFile);
      }

      closeEditModal();
      setInfo("Document updated.");
    } catch (e) {
      setErr(e?.response?.data?.error || e?.message || String(e));
    } finally {
      setEditSaving(false);
    }
  }

  return (
    <div className="max-w-7xl mx-auto p-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-semibold">Vault</h1>
        <div className="flex items-center gap-2">
          <input
            className="input input-bordered"
            style={{ minWidth: 260 }}
            placeholder="Search title, filename, tag…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <label className="text-sm flex items-center gap-2">
            <input
              type="checkbox"
              checked={includeDeleted}
              onChange={(e) => setIncludeDeleted(e.target.checked)}
            />
            Show deleted
          </label>
          <button className="btn btn-sm" onClick={() => setShowCreate(true)}>
            New Document
          </button>
        </div>
      </div>

      {err && <div className="text-red-600 mt-2">{err}</div>}
      {info && <div className="text-green-700 mt-2">{info}</div>}

      <div className="mt-3 overflow-x-auto rounded-xl border">
        <table className="table w-full">
          <thead className="bg-gray-50 sticky top-0 z-10">
            <tr>
              <th style={{ width: 320 }}>Title</th>
              <th style={{ width: 360 }}>Latest</th>
              <th>Tags</th>
              <th>Channel</th>
              <th>Folder</th>
              <th>Updated</th>
              <th className="text-right" style={{ width: 220 }}>
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {docs.length ? (
              docs.map((d, idx) => {
                const id = docIdOf(d);

                return (
                  <tr
                    key={id || `row-${idx}`}
                    className={d.deletedAt ? "opacity-60" : ""}
                  >
                    <td className="align-top">
                      <input
                        className="border p-2 w-full"
                        value={d.title || ""}
                        onChange={(e) =>
                          setDocs((prev) =>
                            prev.map((x) =>
                              docIdOf(x) === id
                                ? { ...x, title: e.target.value }
                                : x,
                            ),
                          )
                        }
                        onBlur={(e) => {
                          const newTitle = String(e.target.value || "").trim();
                          if (id && newTitle && newTitle !== d.title) {
                            doRename(id, newTitle);
                          }
                        }}
                      />
                      {d.deletedAt && (
                        <div className="text-xs text-red-700 mt-1">
                          deleted {new Date(d.deletedAt).toLocaleString()}
                        </div>
                      )}
                    </td>

                    <td className="align-top">
                      {d.latest ? (
                        <button
                          className="underline text-left"
                          title="Open preview"
                          onClick={() => openPreview(d)}
                          style={{
                            maxWidth: 340,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {d.latest.filename}
                        </button>
                      ) : (
                        <span className="text-gray-500">—</span>
                      )}
                    </td>

                    <td className="align-top">
                      <TagOrDash value={d.tags} />
                    </td>
                    <td className="align-top">
                      <Dash value={d.channel} />
                    </td>
                    <td className="align-top">
                      <Dash value={d.folder} />
                    </td>
                    <td className="align-top">
                      {new Date(d.updatedAt || d.createdAt).toLocaleString()}
                    </td>

                    <td className="text-right align-top">
                      {!d.deletedAt ? (
                        <div className="inline-flex gap-2">
                          <button
                            className="btn btn-sm"
                            onClick={() => openEditModal(d)}
                          >
                            Edit
                          </button>
                          <button
                            className="btn btn-sm"
                            onClick={() => doDelete(id)}
                          >
                            Delete
                          </button>
                        </div>
                      ) : (
                        <div className="inline-flex flex-col gap-2 items-end">
                          <button
                            className="btn btn-sm"
                            onClick={() => doRestore(id)}
                          >
                            Restore
                          </button>
                          <button
                            className="btn btn-sm"
                            onClick={() => doHardDelete(id)}
                            title="Admin only"
                            style={{
                              background: "#b91c1c",
                              color: "white",
                              border: "1px solid #7f1d1d",
                            }}
                          >
                            Hard Delete
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td className="p-4 text-gray-600" colSpan={7}>
                  No documents yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="New Document"
      >
        <form onSubmit={doCreate} className="grid md:grid-cols-2 gap-3">
          <label className="text-sm md:col-span-2">
            Title
            <input
              className="border p-2 w-full"
              value={creating.title}
              onChange={(e) =>
                setCreating((prev) => ({
                  ...prev,
                  title: e.target.value,
                }))
              }
              required
            />
          </label>

          <label className="text-sm">
            Channel
            <select
              className="border p-2 w-full"
              value={creating.channel}
              onChange={(e) =>
                setCreating((prev) => {
                  const nextChannel = normalizeChannel(e.target.value);
                  return {
                    ...prev,
                    channel: nextChannel,
                    folder:
                      nextChannel === "mobile-library"
                        ? prev.folder || "policies"
                        : "",
                  };
                })
              }
            >
              {VAULT_CHANNEL_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
            <div className="text-xs text-gray-600 mt-1">
              Use mobile-library only for documents that must appear in the
              mobile app.
            </div>
          </label>

          <label className="text-sm">
            Folder
            <select
              className="border p-2 w-full"
              value={
                creating.channel === "mobile-library"
                  ? creating.folder || "policies"
                  : ""
              }
              disabled={creating.channel !== "mobile-library"}
              onChange={(e) =>
                setCreating((prev) => ({
                  ...prev,
                  folder: e.target.value,
                }))
              }
            >
              <option value="">— none —</option>
              {MOBILE_FOLDER_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
            <div className="text-xs text-gray-600 mt-1">
              Folder is only used when channel = mobile-library.
            </div>
          </label>

          <label className="text-sm md:col-span-2">
            Tags (comma-separated)
            <input
              className="border p-2 w-full"
              value={creating.tags}
              onChange={(e) =>
                setCreating((prev) => ({
                  ...prev,
                  tags: e.target.value,
                }))
              }
              placeholder="safety, onboarding"
            />
          </label>

          <label className="text-sm md:col-span-2">
            Upload file (optional)
            <input
              className="border p-2 w-full"
              type="file"
              onChange={(e) => setCreateFile(e.target.files?.[0] || null)}
            />
            <div className="text-xs text-gray-600 mt-1">
              If you choose a file here, it will be uploaded immediately after
              the document is created.
            </div>
          </label>

          <div className="md:col-span-2 flex items-center gap-2 pt-1">
            <button
              className="px-3 py-2 bg-black text-white rounded disabled:opacity-60"
              type="submit"
              disabled={createSaving}
            >
              {createSaving ? "Creating…" : "Create"}
            </button>

            <button
              type="button"
              className="px-3 py-2 border rounded"
              onClick={() => {
                setShowCreate(false);
                setCreateFile(null);
                setCreating({
                  title: "",
                  channel: "vault-only",
                  folder: "",
                  tags: "",
                });
              }}
              disabled={createSaving}
            >
              Cancel
            </button>
          </div>
        </form>
      </Modal>

      <Modal open={!!editDoc} onClose={closeEditModal} title="Edit Document">
        {editDoc && (
          <div className="space-y-3">
            <div className="grid gap-3 md:grid-cols-2">
              <label className="text-sm md:col-span-2">
                Title
                <input
                  className="border p-2 w-full"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                />
              </label>

              <label className="text-sm">
                Channel
                <select
                  className="border p-2 w-full"
                  value={editChannel}
                  onChange={(e) => {
                    const nextChannel = normalizeChannel(e.target.value);
                    setEditChannel(nextChannel);

                    if (nextChannel === "mobile-library") {
                      setEditFolder((prev) => prev || "policies");
                    } else {
                      setEditFolder("");
                    }
                  }}
                >
                  {VAULT_CHANNEL_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              </label>

              <label className="text-sm">
                Folder
                <select
                  className="border p-2 w-full"
                  value={
                    editChannel === "mobile-library"
                      ? editFolder || "policies"
                      : ""
                  }
                  disabled={editChannel !== "mobile-library"}
                  onChange={(e) => setEditFolder(e.target.value)}
                >
                  <option value="">— none —</option>
                  {MOBILE_FOLDER_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              </label>

              <label className="text-sm md:col-span-2">
                Upload / Replace file
                <input
                  className="border p-2 w-full"
                  type="file"
                  onChange={(e) => setEditFile(e.target.files?.[0] || null)}
                />
                <div className="text-xs text-gray-600 mt-1">
                  Current: {editDoc.latest?.filename || "—"}
                </div>
              </label>
            </div>

            <div className="flex items-center gap-2 pt-2">
              <button
                className="px-3 py-2 bg-black text-white rounded disabled:opacity-60"
                disabled={editSaving}
                onClick={saveEditModal}
              >
                {editSaving ? "Saving…" : "Save"}
              </button>

              <button
                className="px-3 py-2 border rounded"
                onClick={closeEditModal}
              >
                Cancel
              </button>

              <div className="ml-auto flex items-center gap-2">
                {!editDoc.deletedAt && (
                  <button
                    className="px-3 py-2 border rounded"
                    onClick={() => {
                      if (!window.confirm("Delete this document?")) return;
                      doDelete(docIdOf(editDoc));
                      closeEditModal();
                    }}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </Modal>

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
          onMouseDown={closePreview}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl"
            style={{
              width: "100%",
              maxWidth: 1000,
              maxHeight: "90vh",
              display: "flex",
              flexDirection: "column",
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-3 border-b">
              <div className="min-w-0">
                <div
                  className="font-medium truncate"
                  title={previewDoc.latest?.filename || previewDoc.title}
                >
                  {previewDoc.title ||
                    previewDoc.latest?.filename ||
                    "Document"}
                </div>
                <div className="text-xs text-gray-600">
                  Type: {previewMime || "unknown"}
                </div>
              </div>

              <div className="flex items-center gap-2">
                {previewDoc?.latest?.url && (
                  <a
                    className="btn btn-sm"
                    href={fileUrl(previewDoc.latest.url)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Download
                  </a>
                )}
                <button className="btn btn-sm" onClick={closePreview}>
                  Close
                </button>
              </div>
            </div>

            <div style={{ flex: 1, overflow: "auto", background: "#f7f7f7" }}>
              {pvLoading && (
                <div className="p-4 text-gray-700 text-sm">
                  Loading preview…
                </div>
              )}

              {pvErr && <div className="p-4 text-red-600 text-sm">{pvErr}</div>}

              {!pvLoading && !pvErr && (
                <>
                  {textLike && (
                    <div className="p-3">
                      <pre
                        style={{
                          whiteSpace: "pre-wrap",
                          background: "white",
                          border: "1px solid #eee",
                          borderRadius: 8,
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
                    <div className="p-3 flex justify-center">
                      <img
                        src={pvUrl}
                        alt={previewDoc.latest?.filename || previewDoc.title}
                        style={{
                          maxWidth: "100%",
                          maxHeight: "75vh",
                          objectFit: "contain",
                          borderRadius: 8,
                          background: "white",
                        }}
                      />
                    </div>
                  )}

                  {isVideo && pvUrl && (
                    <div className="p-3">
                      <video
                        src={pvUrl}
                        controls
                        style={{
                          width: "100%",
                          maxHeight: "75vh",
                          background: "black",
                          borderRadius: 8,
                        }}
                      />
                    </div>
                  )}

                  {isAudio && pvUrl && (
                    <div className="p-3">
                      <audio src={pvUrl} controls style={{ width: "100%" }} />
                    </div>
                  )}

                  {isPdf && pvUrl && (
                    <div style={{ height: "75vh" }}>
                      <iframe
                        title="PDF preview"
                        src={pvUrl}
                        style={{ width: "100%", height: "100%", border: 0 }}
                      />
                    </div>
                  )}

                  {!textLike && !isImage && !isVideo && !isAudio && !isPdf && (
                    <div className="p-4 text-gray-700 text-sm">
                      Preview not available. Use <b>Download</b> to open the
                      file.
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
