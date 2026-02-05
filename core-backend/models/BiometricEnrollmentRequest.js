const mongoose = require("mongoose");
const { Schema } = mongoose;

/**
 * One record per biometric onboarding attempt coming from mobile.
 * This is created from /api/mobile/offline-events (biometric-enroll).
 * It is later reviewed/processed to produce a BiometricEnrollment.
 */
const BiometricEnrollmentRequestSchema = new Schema(
  {
    orgId: {
      type: Schema.Types.ObjectId,
      ref: "Org",
      required: true,
      index: true,
    },

    // Person being enrolled
    targetUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // Who performed the onboarding (manager/admin)
    performedByUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    performedByEmail: { type: String, trim: true },
    performedByRoles: [{ type: String, trim: true }],

    // Optional context
    groupId: {
      type: Schema.Types.ObjectId,
      ref: "Group",
    },

    status: {
      type: String,
      enum: ["pending", "processing", "approved", "rejected"],
      default: "pending",
      index: true,
    },

    // Files uploaded via GridFS (already confirmed working)
    uploadedFiles: [
      {
        fileId: { type: Schema.Types.ObjectId, required: true },
        filename: { type: String },
        contentType: { type: String },
        size: { type: Number },
      },
    ],

    // Reference back to offline_events document (traceability)
    sourceOfflineEventId: {
      type: Schema.Types.ObjectId,
      ref: "OfflineEvent",
      index: true,
    },

    notes: { type: String, trim: true },

    createdAtClient: { type: Date },
  },
  { timestamps: true },
);

BiometricEnrollmentRequestSchema.index(
  { orgId: 1, targetUserId: 1, createdAt: -1 },
  { name: "org_target_latest" },
);

const modelName = "BiometricEnrollmentRequest";
module.exports =
  mongoose.models[modelName] ||
  mongoose.model(modelName, BiometricEnrollmentRequestSchema);
