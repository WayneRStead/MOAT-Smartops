// core-backend/models/BiometricEnrollment.js
const mongoose = require("mongoose");
const { Schema } = mongoose;

/**
 * BiometricEnrollment
 * - This is the "final" biometric record for a user.
 * - We allow creating it in a PENDING state *without* an embedding yet,
 *   because the mobile app uploads photos first and embedding generation
 *   can happen later (server job / manual approval flow / ML pipeline).
 */
const BiometricEnrollmentSchema = new Schema(
  {
    orgId: {
      type: Schema.Types.ObjectId,
      ref: "Org",
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // workflow status
    status: {
      type: String,
      enum: ["pending", "enrolled", "rejected", "revoked", "expired"],
      default: "pending",
      index: true,
    },

    /**
     * Only required once enrolled (once we have embedding generated).
     * When status=pending, these can be empty/null.
     */
    templateVersion: {
      type: String,
      trim: true,
      required: function () {
        return String(this.status) === "enrolled";
      },
    },

    // WARNING: In production, encrypt this Buffer before saving (KMS/AEAD).
    embedding: {
      type: Buffer,
      required: function () {
        return String(this.status) === "enrolled";
      },
      select: false, // never return embedding by default
    },

    /**
     * Store references to uploaded images (GridFS fileIds) that came from
     * BiometricEnrollmentRequest uploadedFiles[].fileId.
     *
     * We keep them here so the next pipeline step can fetch photos and
     * generate embedding later.
     */
    photoFileIds: {
      type: [Schema.Types.ObjectId],
      default: [],
      index: true,
    },

    /**
     * Link back to the request that created this enrollment (audit trail).
     */
    sourceRequestId: {
      type: Schema.Types.ObjectId,
      ref: "BiometricEnrollmentRequest",
      index: true,
    },

    livenessScore: { type: Number },
    captureMeta: {
      deviceId: { type: String, trim: true },
      appVersion: { type: String, trim: true },
      geo: {
        lat: { type: Number },
        lon: { type: Number },
      },
      capturedAt: { type: Date },
    },

    // Approvals / lifecycle
    approvedBy: { type: Schema.Types.ObjectId, ref: "User" },
    approvedAt: { type: Date },
    rejectedBy: { type: Schema.Types.ObjectId, ref: "User" },
    rejectedAt: { type: Date },
    rejectReason: { type: String, trim: true },
    revokedBy: { type: Schema.Types.ObjectId, ref: "User" },
    revokedAt: { type: Date },
    revokeReason: { type: String, trim: true },

    // Consent
    consentVersion: { type: String, trim: true },
    consentedAt: { type: Date },
  },
  { timestamps: true },
);

BiometricEnrollmentSchema.index({ orgId: 1, userId: 1, status: 1 });
BiometricEnrollmentSchema.index({ orgId: 1, userId: 1, createdAt: -1 });

const modelName = "BiometricEnrollment";
module.exports =
  mongoose.models[modelName] ||
  mongoose.model(modelName, BiometricEnrollmentSchema);
