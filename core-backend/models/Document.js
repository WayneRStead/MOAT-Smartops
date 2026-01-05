// core-backend/models/Document.js
const mongoose = require("mongoose");

const { Schema, Types } = mongoose;

/**
 * Version schema (with legacy field compatibility)
 * Canonical fields: filename, url, fileId, mime, size, uploadedBy, uploadedAt, deletedAt, deletedBy, sha256, thumbUrl
 * Legacy mirrors: fileName, path, mimeType
 */
const VersionSchema = new Schema(
  {
    // Canonical
    filename: String,
    url: String, // e.g. /documents/files/<fileId>  (or legacy /files/docs/<...>)
    fileId: String, // GridFS ObjectId as string (24-hex) — IMPORTANT
    mime: String,
    size: Number, // bytes
    sha256: String, // optional checksum
    thumbUrl: String, // optional small preview thumbnail
    uploadedAt: { type: Date, default: Date.now },

    // Accept either ObjectId or string (e.g., "admin@smartops")
    uploadedBy: Schema.Types.Mixed, // {ObjectId | String}
    deletedAt: Date,
    deletedBy: Schema.Types.Mixed, // {ObjectId | String}

    // Legacy mirrors for backward compatibility
    fileName: String, // mirror of filename
    path: String, // mirror of url
    mimeType: String, // mirror of mime
  },
  { _id: false, strict: true }
);

// Keep canonical <-> legacy fields in sync
function syncVersionLegacyFields(v) {
  if (!v) return;

  // filename <-> fileName
  if (v.filename && !v.fileName) v.fileName = v.filename;
  if (!v.filename && v.fileName) v.filename = v.fileName;

  // url <-> path
  if (v.url && !v.path) v.path = v.url;
  if (!v.url && v.path) v.url = v.path;

  // mime <-> mimeType
  if (v.mime && !v.mimeType) v.mimeType = v.mime;
  if (!v.mime && v.mimeType) v.mime = v.mimeType;

  // Infer fileId from url/path if possible (helps legacy docs after switching to GridFS)
  const maybe = String(v.fileId || "");
  if (!maybe || maybe.length < 24) {
    const u = String(v.url || v.path || "");
    // /documents/files/<24hex>
    let m = u.match(/\/documents\/files\/([0-9a-fA-F]{24})$/);
    // also tolerate /api/documents/files/<24hex>
    if (!m) m = u.match(/\/api\/documents\/files\/([0-9a-fA-F]{24})$/);
    // also tolerate /files/docs/<24hex> (if you decide to expose it like that later)
    if (!m) m = u.match(/\/files\/docs\/([0-9a-fA-F]{24})$/);
    if (m) v.fileId = m[1];
  }
}

VersionSchema.pre("validate", function (next) {
  syncVersionLegacyFields(this);
  next();
});

/**
 * Link schema
 * Store both `type` and `module` for compatibility (values like 'project','inspection','asset','vehicle','user','task','clocking')
 * NOTE: refId is Mixed so we can store either ObjectId or string IDs consistently.
 */
const LinkSchema = new Schema(
  {
    type: { type: String }, // canonical
    module: { type: String }, // legacy/canonical alias
    refId: { type: Schema.Types.Mixed, required: true }, // ObjectId or String
  },
  { _id: false, strict: true }
);

const DocumentSchema = new Schema(
  {
    orgId: { type: Types.ObjectId, ref: "Org", index: true },

    title: { type: String, required: true },
    folder: { type: String, index: true }, // e.g., "Site A/Contracts"
    tags: [{ type: String, index: true }],

    // Flexible access object (e.g., { visibility: 'org', owners: [...] })
    access: Schema.Types.Mixed,

    links: [LinkSchema],

    // All versions + latest snapshot
    versions: [VersionSchema],
    latest: VersionSchema, // snapshot of the currently "active" version

    // Soft delete on document
    deletedAt: Date,
    deletedBy: Schema.Types.Mixed, // {ObjectId | String}

    // Audit — accept ObjectId or string actor ids
    createdAt: { type: Date, default: Date.now },
    createdBy: Schema.Types.Mixed, // {ObjectId | String}
    updatedAt: { type: Date, default: Date.now },
    updatedBy: Schema.Types.Mixed, // {ObjectId | String}

    // Legacy leftover (not used by routes, kept for compatibility)
    latestIndex: { type: Number, default: 0 },
  },
  {
    timestamps: false, // we manage createdAt/updatedAt ourselves
    strict: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret) {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
    toObject: {
      virtuals: true,
      transform(_doc, ret) {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

// ---------- Indexes ----------
DocumentSchema.index({ orgId: 1, folder: 1, title: 1 });
DocumentSchema.index({ title: "text" });
// Speed up link queries (supports both .type and .module)
DocumentSchema.index({ "links.type": 1, "links.refId": 1 });
DocumentSchema.index({ "links.module": 1, "links.refId": 1 });
DocumentSchema.index({ "latest.filename": 1 });
DocumentSchema.index({ "latest.uploadedBy": 1 });
DocumentSchema.index({ deletedAt: 1 });

/* --------------------------- Normalizers & hooks -------------------------- */
function normalizeTag(t) {
  if (typeof t !== "string") return "";
  return t.trim().toLowerCase();
}

function normalizeLink(l) {
  if (!l) return null;
  const out = {
    type: typeof l.type === "string" ? l.type.trim().toLowerCase() : l.type,
    module: typeof l.module === "string" ? l.module.trim().toLowerCase() : l.module,
    refId: l.refId,
  };
  // keep type/module in sync if one missing
  if (out.type && !out.module) out.module = out.type;
  if (!out.type && out.module) out.type = out.module;
  return out;
}

function dedupeLinks(arr) {
  const seen = new Set();
  const out = [];
  for (const raw of arr || []) {
    const l = normalizeLink(raw);
    if (!l || l.refId == null) continue;
    const key = `${String(l.type)}:${String(l.refId)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}

DocumentSchema.pre("validate", function normalizeFields(next) {
  // Ensure title trimmed
  if (typeof this.title === "string") this.title = this.title.trim();

  // Normalize folder (keep as-is but trim spaces)
  if (typeof this.folder === "string") this.folder = this.folder.trim();

  // Normalize/dedupe tags
  if (Array.isArray(this.tags)) {
    const dedup = Array.from(new Set(this.tags.map(normalizeTag).filter(Boolean)));
    this.tags = dedup;
  }

  // Normalize/dedupe links
  if (Array.isArray(this.links)) {
    this.links = dedupeLinks(this.links);
  }

  // Keep versions' legacy fields in sync (in case push used raw objects)
  if (Array.isArray(this.versions)) {
    this.versions.forEach((v) => syncVersionLegacyFields(v));
  }
  if (this.latest) syncVersionLegacyFields(this.latest);

  next();
});

DocumentSchema.pre("save", function stampUpdatedAt(next) {
  this.updatedAt = new Date();
  next();
});

/* ------------------------------- Methods -------------------------------- */
// Helper to recompute latest (most recent non-deleted version)
DocumentSchema.methods.recomputeLatest = function recomputeLatest() {
  if (!this.versions || this.versions.length === 0) {
    this.latest = undefined;
    return;
  }
  for (let i = this.versions.length - 1; i >= 0; i--) {
    const v = this.versions[i];
    if (!v.deletedAt) {
      this.latest = v;
      return;
    }
  }
  this.latest = undefined;
};

// Add a new version and update latest; accepts canonical or legacy keys.
DocumentSchema.methods.addVersion = function addVersion(file, actor) {
  if (!file) return this;

  const v = {
    filename: file.filename || file.fileName,
    fileName: file.fileName || file.filename,

    url: file.url || file.path,
    path: file.path || file.url,

    fileId: file.fileId ? String(file.fileId) : undefined,

    mime: file.mime || file.mimeType,
    mimeType: file.mimeType || file.mime,

    size: typeof file.size === "number" ? file.size : undefined,
    sha256: file.sha256 || file.hash || undefined,
    thumbUrl: file.thumbUrl || undefined,

    uploadedAt: new Date(),
    uploadedBy: actor ?? undefined,
  };

  // sync mirrors & push
  syncVersionLegacyFields(v);
  this.versions = Array.isArray(this.versions) ? this.versions : [];
  this.versions.push(v);
  this.latest = v;

  // bump audit
  this.updatedAt = new Date();
  if (actor) this.updatedBy = actor;

  return this;
};

// Soft delete entire document
DocumentSchema.methods.softDelete = function softDelete(actor) {
  this.deletedAt = new Date();
  this.deletedBy = actor ?? undefined;
  this.updatedAt = new Date();
  if (actor) this.updatedBy = actor;
  return this;
};

// Restore entire document
DocumentSchema.methods.restore = function restore(actor) {
  this.deletedAt = null;
  this.deletedBy = null;
  this.updatedAt = new Date();
  if (actor) this.updatedBy = actor;
  return this;
};

// Soft delete a specific version by array index; recompute latest
DocumentSchema.methods.softDeleteVersion = function softDeleteVersion(index, actor) {
  if (!Array.isArray(this.versions)) return this;
  const i = Number(index);
  if (Number.isInteger(i) && i >= 0 && i < this.versions.length) {
    const v = this.versions[i];
    if (v && !v.deletedAt) {
      v.deletedAt = new Date();
      v.deletedBy = actor ?? undefined;
      syncVersionLegacyFields(v);
      this.recomputeLatest();
      this.updatedAt = new Date();
      if (actor) this.updatedBy = actor;
    }
  }
  return this;
};

// Restore a soft-deleted version by index; recompute latest
DocumentSchema.methods.restoreVersion = function restoreVersion(index, actor) {
  if (!Array.isArray(this.versions)) return this;
  const i = Number(index);
  if (Number.isInteger(i) && i >= 0 && i < this.versions.length) {
    const v = this.versions[i];
    if (v && v.deletedAt) {
      v.deletedAt = undefined;
      v.deletedBy = undefined;
      syncVersionLegacyFields(v);
      this.recomputeLatest();
      this.updatedAt = new Date();
      if (actor) this.updatedBy = actor;
    }
  }
  return this;
};

// Add a link (deduped by type+refId)
DocumentSchema.methods.addLink = function addLink({ type, module, refId }) {
  const norm = normalizeLink({ type, module, refId });
  if (!norm || norm.refId == null) return this;
  this.links = dedupeLinks([...(this.links || []), norm]);
  this.updatedAt = new Date();
  return this;
};

// Remove a link (by type+refId)
DocumentSchema.methods.removeLink = function removeLink({ type, module, refId }) {
  const t = (type || module || "").toString().toLowerCase();
  const r = refId != null ? String(refId) : null;
  if (!t || r == null) return this;
  this.links = (this.links || []).filter((l) => !(String(l.type).toLowerCase() === t && String(l.refId) === r));
  this.updatedAt = new Date();
  return this;
};

module.exports = mongoose.models.Document || mongoose.model("Document", DocumentSchema);
