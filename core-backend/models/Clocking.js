// core-backend/models/Clocking.js
const mongoose = require('mongoose');

// Suggested types for UI (not enforced in schema to stay backward-compatible)
const CLOCK_TYPES = [
  'present', 'in', 'out', 'training', 'sick', 'leave', 'iod', 'overtime'
];

const AttachmentSchema = new mongoose.Schema({
  filename:   String,
  url:        String,
  mime:       String,
  size:       Number,
  uploadedBy: String,                 // req.user?.sub or email (string)
  uploadedAt: { type: Date, default: Date.now },
}, { _id: false });

const LocationSchema = new mongoose.Schema({
  lat: Number,
  lng: Number,
  acc: Number,                        // accuracy meters (optional)
}, { _id: false });

const ClockingEditSchema = new mongoose.Schema({
  editedAt:   { type: Date,   default: Date.now, index: true },
  editedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  note:       { type: String, default: '' },
  changes:    [{
    field:  { type: String, required: true },          // e.g. "start", "end", "status", "location.lat"
    before: { type: mongoose.Schema.Types.Mixed },     // old value
    after:  { type: mongoose.Schema.Types.Mixed },     // new value
  }],
}, { _id: false });

const ClockingSchema = new mongoose.Schema({
  orgId:     { type: String, default: 'root', index: true },  // simple org scoping
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', index: true },

  // NOTE: no enum here — prevents crashes on legacy/unknown values
  type:      { type: String, default: 'present', index: true },

  at:        { type: Date, default: Date.now, index: true },
  notes:     { type: String, default: '' },

  location:     LocationSchema,
  attachments: [ AttachmentSchema ],

  createdBy:    { type: String },        // req.user?.sub or email

  // --- Audit fields ---
  lastEditedAt: { type: Date },
  lastEditedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  editLog:      { type: [ClockingEditSchema], default: [] },
}, { timestamps: true });

// Useful query index
ClockingSchema.index({ projectId: 1, userId: 1, at: -1 });

const Clocking = mongoose.model('Clocking', ClockingSchema);

module.exports = Clocking;
module.exports.CLOCK_TYPES = CLOCK_TYPES;
