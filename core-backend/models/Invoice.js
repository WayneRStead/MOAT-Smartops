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

    // Upload (PDF or whatever)
    fileUrl: { type: String, default: null },
    fileName: { type: String, default: null },
    fileSize: { type: Number, default: null },
    fileType: { type: String, default: null },

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

module.exports = mongoose.models.Invoice || mongoose.model("Invoice", InvoiceSchema);
