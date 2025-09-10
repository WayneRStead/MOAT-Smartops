// core-backend/models/Asset.js
const mongoose = require('mongoose');

const AttachmentSchema = new mongoose.Schema({
  url:        { type: String, required: true },   // e.g. /files/assets/123_photo.jpg
  filename:   { type: String },
  mime:       { type: String },
  size:       { type: Number },
  uploadedAt: { type: Date, default: Date.now },
  uploadedBy: { type: String },
  note:       { type: String },
}, { _id: true });

const MaintenanceSchema = new mongoose.Schema({
  date: { type: Date },
  note: { type: String },
  by:   { type: String },
}, { _id: true });

const AssetSchema = new mongoose.Schema({
  name:       { type: String, required: true, trim: true },
  code:       { type: String, trim: true },
  type:       { type: String, trim: true },
  status:     { type: String, enum: ['active','maintenance','retired'], default: 'active' },
  projectId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Project', default: null },
  notes:      { type: String },

  // Location — like Clockings
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

  // Photos — like Task attachments
  attachments: [AttachmentSchema],

  // Existing maintenance feature
  maintenance: [MaintenanceSchema],
}, { timestamps: true });

function num(v) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : undefined;
}

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
    // one provided without the other → clear location to avoid partials
    delete $set.lat; delete $set.lng; delete $set.location; delete $set.geometry;
  }

  u.$set = $set;
  this.setUpdate(u);
  next();
});

module.exports = mongoose.model('Asset', AssetSchema);
