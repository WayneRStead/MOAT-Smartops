const mongoose = require('mongoose');

const UploadSchema = new mongoose.Schema({
  filename: String,
  originalName: String,
  mimeType: String,
  size: Number,
  path: String,
}, { timestamps: true });

module.exports = mongoose.model('Upload', UploadSchema);
