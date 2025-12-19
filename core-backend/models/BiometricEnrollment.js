// core-backend/models/BiometricEnrollment.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

/**
 * Sensitive biometric data lives here (separate from User for least-privilege).
 * Store embeddings encrypted at rest in production (TODO noted below).
 */
const BiometricEnrollmentSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    status: {
      type: String,
      enum: ['pending','enrolled','rejected','revoked','expired'],
      default: 'pending',
      index: true,
    },

    templateVersion: { type: String, trim: true, required: true },

    // WARNING: In production, encrypt this Buffer before saving (KMS/AEAD).
    embedding: { type: Buffer, required: true }, // expects bytes, not exposed in APIs

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

    // Optional attached photo object ID if captured during enrollment
    photoObjectId: { type: String, trim: true },

    // Approvals
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
    rejectedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    rejectedAt: { type: Date },
    rejectReason: { type: String, trim: true },
    revokedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    revokedAt: { type: Date },
    revokeReason: { type: String, trim: true },

    // Consent
    consentVersion: { type: String, trim: true },
    consentedAt: { type: Date },
  },
  { timestamps: true }
);

BiometricEnrollmentSchema.index({ orgId: 1, userId: 1, status: 1 });
BiometricEnrollmentSchema.index({ orgId: 1, userId: 1, createdAt: -1 });

const modelName = 'BiometricEnrollment';
module.exports = mongoose.models[modelName] || mongoose.model(modelName, BiometricEnrollmentSchema);
