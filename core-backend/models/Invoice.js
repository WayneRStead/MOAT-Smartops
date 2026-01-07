// core-backend/models/Invoice.js
const mongoose = require("mongoose");
const { Schema } = mongoose;

const InvoiceSchema = new Schema(
  {
    orgId: { type: Schema.Types.Mixed, index: true }, // allow string or ObjectId

    // Core
    number: { type: String, required: true, index: true },
    projectId: { type: Schema.Types.Mixed, index: true }, // allow string or ObjectId
    projectName: { type: String }, // denormalized for display
    vendorId: { type: Schema.Types.Mixed, index: true, default: null },
    vendorName: { type: String, required: true },

    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "USD" },

    // Dates & terms
    submittedAt: { type: Date, required: true }, // "Date Submitted"
    dueAt: { type: Date }, // can be supplied; else derived from netDays/terms
    netDays: { type: Number, default: 30, min: 0 }, // "Account type" (e.g., 30 days)
    paidAt: { type: Date },

    // Status: submitted | outstanding | paid | void
    status: { type: String, default: "submitted", index: true },
    notes: { type: String, default: "" },

    // -------------------- File attachment (GridFS-first) --------------------
    /**
     * fileUrl:
     *   Frontend-friendly public path, e.g.
     *   /files/invoices/<orgId>/<filename>
     *
     * When using GridFS, index.js now serves this URL by reading from:
     *   invoices.files (bucketName: "invoices")
     * where files are stored with metadata.orgId = String(orgId)
     */
    fileUrl: { type: String, default: null },
    fileName: { type: String, default: null }, // original file name for UI
    fileSize: { type: Number, default: null },
    fileType: { type: String, default: null },

    // New: persist GridFS linkage (optional but very helpful for admin + cleanup)
    fileStorage: { type: String, enum: ["gridfs", "disk"], default: "gridfs" },
    fileGridFsId: { type: Schema.Types.ObjectId, default: null, index: true }, // invoices.files._id
    fileBucket: { type: String, default: "invoices" }, // bucketName (future-proof)

    // ✅ Soft delete (for "Show deleted" UI + restore workflows)
    deleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.Mixed, default: null },

    // Audit
    createdBy: { type: Schema.Types.Mixed, default: null },
    updatedBy: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

// Helpful compound indexes (optional)
InvoiceSchema.index({ orgId: 1, number: 1 }, { unique: false });
InvoiceSchema.index({ orgId: 1, projectId: 1, submittedAt: -1 });

// ✅ Index to speed up normal list queries (non-deleted first)
InvoiceSchema.index({ orgId: 1, deleted: 1, submittedAt: -1 });

// ✅ Optional: speed up "has attachment" queries
InvoiceSchema.index({ orgId: 1, fileGridFsId: 1 });

/* ---------------------- lightweight normalization ---------------------- */
// Keep fileStorage consistent if someone backfills legacy disk URLs.
InvoiceSchema.pre("validate", function (next) {
  try {
    if (this.fileGridFsId) {
      this.fileStorage = "gridfs";
    } else if (this.fileUrl && /\/files\/invoices\//i.test(String(this.fileUrl))) {
      // could still be gridfs served by filename; leave as-is unless explicitly set
      this.fileStorage = this.fileStorage || "gridfs";
    }
    next();
  } catch (e) {
    next(e);
  }
});

module.exports = mongoose.models.Invoice || mongoose.model("Invoice", InvoiceSchema);
