// models/Document.js
const mongoose = require('mongoose');

const { Schema, Types } = mongoose;

/**
 * Version schema (with legacy field compatibility)
 * Canonical fields: filename, url, mime, size, uploadedBy, uploadedAt, deletedAt, deletedBy, sha256
 * Legacy mirrors: fileName, path, mimeType
 */
const VersionSchema = new Schema(
  {
    // Canonical
    filename: String,
    url: String,               // e.g. /files/docs/<...>
    mime: String,
    size: Number,              // bytes
    sha256: String,            // optional checksum
    uploadedAt: { type: Date, default: Date.now },

    // Accept either ObjectId or string (e.g., "admin@smartops")
    uploadedBy: Schema.Types.Mixed, // {ObjectId | String}
    deletedAt: Date,
    deletedBy: Schema.Types.Mixed,  // {ObjectId | String}

    // Legacy mirrors for backward compatibility
    fileName: String,          // mirror of filename
    path: String,              // mirror of url
    mimeType: String,          // mirror of mime
  },
  { _id: false }
);

// Keep canonical <-> legacy fields in sync when saving
VersionSchema.pre('save', function syncLegacy(next) {
  if (this.filename && !this.fileName) this.fileName = this.filename;
  if (!this.filename && this.fileName) this.filename = this.fileName;

  if (this.url && !this.path) this.path = this.url;
  if (!this.url && this.path) this.url = this.path;

  if (this.mime && !this.mimeType) this.mimeType = this.mime;
  if (!this.mime && this.mimeType) this.mime = this.mimeType;

  next();
});

/**
 * Link schema
 * Store both `type` and `module` for compatibility (values like 'project','inspection','asset','vehicle','user')
 */
const LinkSchema = new Schema(
  {
    type: { type: String },             // canonical
    module: { type: String },           // legacy/canonical alias
    refId: { type: Types.ObjectId, required: true },
  },
  { _id: false }
);

const DocumentSchema = new Schema(
  {
    orgId: { type: Types.ObjectId, ref: 'Org', index: true },

    title: { type: String, required: true },
    folder: { type: String, index: true }, // e.g., "Site A/Contracts"
    tags: [{ type: String, index: true }],

    // Flexible access object (e.g., { visibility: 'org', owners: [...] })
    access: Schema.Types.Mixed,

    links: [LinkSchema],

    // All versions + latest snapshot
    versions: [VersionSchema],
    latest: VersionSchema,              // snapshot of the currently "active" version

    // Soft delete on document
    deletedAt: Date,
    deletedBy: Schema.Types.Mixed,      // {ObjectId | String}

    // Audit — accept ObjectId or string actor ids
    createdAt: { type: Date, default: Date.now },
    createdBy: Schema.Types.Mixed,      // {ObjectId | String}
    updatedAt: { type: Date, default: Date.now },
    updatedBy: Schema.Types.Mixed,      // {ObjectId | String}

    // Legacy leftover (not used by routes, kept for compatibility)
    latestIndex: { type: Number, default: 0 },
  },
  {
    timestamps: false, // we manage createdAt/updatedAt ourselves
  }
);

// ---------- Indexes ----------
DocumentSchema.index({ orgId: 1, folder: 1, title: 1 });
DocumentSchema.index({ title: 'text' });
// Speed up link queries (supports both .type and .module)
DocumentSchema.index({ 'links.type': 1, 'links.refId': 1 });
DocumentSchema.index({ 'links.module': 1, 'links.refId': 1 });
DocumentSchema.index({ 'latest.filename': 1 });
DocumentSchema.index({ 'latest.uploadedBy': 1 });
DocumentSchema.index({ deletedAt: 1 });

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

// Safety net: if latest is missing while saving, recompute it
DocumentSchema.pre('save', function ensureLatest(next) {
  if (!this.latest && Array.isArray(this.versions) && this.versions.length > 0) {
    this.recomputeLatest();
  }
  next();
});

module.exports = mongoose.model('Document', DocumentSchema);
