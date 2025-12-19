// core-backend/models/Inspection.js
const mongoose = require('mongoose');

const FileSchema = new mongoose.Schema({
  filename:   String,
  url:        String,         // e.g. /files/inspections/<inspectionId>/<filename>
  mime:       String,
  size:       Number,
  uploadedBy: String,         // store req.user.sub or email (string)
  uploadedAt: { type: Date, default: Date.now },
}, { _id: false });

const LinkSchema = new mongoose.Schema({
  type:  { type: String, enum: ['project','inspection','asset','vehicle','user','task','clocking'], required: true },
  refId: { type: mongoose.Schema.Types.ObjectId, required: true },
}, { _id: false });

const InspectionSchema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', index: true },
  title:     { type: String, required: true, index: 'text' },
  status:    { type: String, enum: ['open','in-progress','closed'], default: 'open', index: true },
  notes:     { type: String, default: '' },
  files:     [FileSchema],     // optional attachments
  links:     [LinkSchema],     // << add links INSIDE schema definition
}, { timestamps: true });

// Helpful compound index for common filters
InspectionSchema.index({ projectId: 1, status: 1, updatedAt: -1 });

module.exports = mongoose.model('Inspection', InspectionSchema);
