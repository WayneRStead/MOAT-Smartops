// core-backend/models/Asset.js
const mongoose = require('mongoose');

const AttachmentSchema = new mongoose.Schema({
  url:        { type: String, required: true },
  filename:   { type: String },
  mime:       { type: String },
  size:       { type: Number },
  uploadedAt: { type: Date, default: Date.now },
  uploadedBy: { type: String },
  uploadedByLabel: { type: String },
  uploadedByDisplay: { type: String },
  note:       { type: String },

  // Geo context for map/KMZ
  lat:        { type: Number },
  lng:        { type: Number },
  acc:        { type: Number },
  scanned:    { type: Boolean, default: false },
}, { _id: true });

const MaintenanceSchema = new mongoose.Schema({
  date:     { type: Date },
  note:     { type: String },
  by:       { type: String },

  // Geo context for map/KMZ
  lat:      { type: Number },
  lng:      { type: Number },
  acc:      { type: Number },
  scanned:  { type: Boolean, default: false },
}, { _id: true, timestamps: true });

const ALLOWED_STATUSES = ['active','maintenance','retired','lost','stolen'];

const AssetSchema = new mongoose.Schema({
  /* ---------- tenancy ---------- */
  orgId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Org', index: true },

  /* ---------- core fields ---------- */
  name:       { type: String, required: true, trim: true },
  code:       { type: String, trim: true },
  type:       { type: String, trim: true },
  status:     { type: String, enum: ALLOWED_STATUSES, default: 'active' },

  projectId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Project', default: null, index: true },
  notes:      { type: String },

  // Location
  lat:        { type: Number },
  lng:        { type: Number },
  location:   {
    lat: { type: Number },
    lng: { type: Number },
  },
  geometry:   {
    type:        { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number] } // [lng, lat]
  },

  // Files
  attachments: [AttachmentSchema],

  // Logs
  maintenance: [MaintenanceSchema],
}, { timestamps: true });

/* helpful compound indexes for list queries */
AssetSchema.index({ orgId: 1, updatedAt: -1 });
AssetSchema.index({ orgId: 1, status: 1, updatedAt: -1 });
AssetSchema.index({ orgId: 1, name: 1 });
AssetSchema.index({ orgId: 1, code: 1 });

function num(v) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : undefined;
}

AssetSchema.pre('validate', function(next) {
  if (this.isModified('status') && typeof this.status === 'string') {
    const s = this.status.trim().toLowerCase();
    const canon = (
      s === 'missing' || s === 'misplaced' ? 'lost' :
      s === 'theft' || s === 'reported stolen' ? 'stolen' :
      s
    );
    if (ALLOWED_STATUSES.includes(canon)) this.status = canon;
  }
  next();
});

AssetSchema.pre('save', function(next) {
  const lat = num(this.lat ?? this.location?.lat);
  const lng = num(this.lng ?? this.location?.lng);
  if (lat != null && lng != null) {
    this.lat = lat; this.lng = lng;
    this.location = { lat, lng };
    this.geometry = { type: 'Point', coordinates: [lng, lat] };
  } else {
    this.lat = undefined; this.lng = undefined;
    this.location = this.location && (this.location.lat != null || this.location.lng != null)
      ? this.location : undefined;
    this.geometry = undefined;
  }
  next();
});

AssetSchema.pre('findOneAndUpdate', function(next) {
  const u = this.getUpdate() || {};
  const $set = u.$set || u;

  if ($set.status && typeof $set.status === 'string') {
    const s = $set.status.trim().toLowerCase();
    const canon = (
      s === 'missing' || s === 'misplaced' ? 'lost' :
      s === 'theft' || s === 'reported stolen' ? 'stolen' :
      s
    );
    if (ALLOWED_STATUSES.includes(canon)) $set.status = canon;
  }

  const lat = num($set.lat ?? $set.location?.lat);
  const lng = num($set.lng ?? $set.location?.lng);

  if (lat != null && lng != null) {
    $set.lat = lat; $set.lng = lng;
    $set.location = { ...( $set.location || {} ), lat, lng };
    $set.geometry = { type: 'Point', coordinates: [lng, lat] };
  } else if ($set.location && (num($set.location.lat) != null && num($set.location.lng) != null)) {
    const la = num($set.location.lat), lo = num($set.location.lng);
    $set.lat = la; $set.lng = lo;
    $set.geometry = { type: 'Point', coordinates: [lo, la] };
  } else if ('lat' in $set || 'lng' in $set) {
    delete $set.lat; delete $set.lng; delete $set.location; delete $set.geometry;
  }

  u.$set = $set;
  this.setUpdate(u);
  next();
});

module.exports = mongoose.model('Asset', AssetSchema);
