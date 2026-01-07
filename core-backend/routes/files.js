// core-backend/routes/files.js
const express = require("express");
const mongoose = require("mongoose");
const { getBucket } = require("../lib/gridfs");

const router = express.Router();

function isObjectId(v) {
  return mongoose.Types.ObjectId.isValid(String(v));
}

// GET /files/tasks/:fileId
router.get("/tasks/:fileId", async (req, res) => {
  try {
    const { fileId } = req.params;
    if (!isObjectId(fileId)) {
      return res.status(400).json({ error: "bad fileId" });
    }

    const _id = new mongoose.Types.ObjectId(String(fileId));
    const bucket = getBucket();

    // Find file metadata first (useful for headers)
    const files = await bucket.find({ _id }).limit(1).toArray();
    if (!files.length) return res.status(404).json({ error: "file not found" });

    const file = files[0];

    // Headers (must be set BEFORE streaming)
    const ct = String(file.contentType || "application/octet-stream").toLowerCase();
    res.setHeader("Content-Type", file.contentType || "application/octet-stream");

    // Cache: images can be cached for 1 day; non-images shorter by default
    if (ct.startsWith("image/")) {
      res.setHeader("Cache-Control", "public, max-age=86400"); // 1 day
    } else {
      res.setHeader("Cache-Control", "public, max-age=3600"); // 1 hour
    }

    // Inline so images display in UI
    const safeName = String(file.filename || "file").replace(/["\r\n]/g, "");
    res.setHeader("Content-Disposition", `inline; filename="${safeName}"`);

    // Stream from GridFS to response
    const stream = bucket.openDownloadStream(_id);

    stream.on("error", (err) => {
      console.error("GridFS download error:", err);
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });

    stream.pipe(res);
  } catch (e) {
    console.error("GET /files/tasks/:fileId error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
