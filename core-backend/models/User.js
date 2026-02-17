// core-backend/models/User.js
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const { Schema } = mongoose;

/** Canonical roles for this app (keep 'worker' as canonical base role) */
const ROLE_ENUM = [
  "worker",
  "group-leader",
  "project-manager",
  "manager",
  "admin",
  "superadmin",
];

/** Global roles (cross-tenant) */
const GLOBAL_ROLE_ENUM = ["superadmin", "support"];

/** Normalize inbound role strings (accept aliases like "user" → "worker") */
function normalizeRole(val) {
  if (val == null) return undefined;
  const v = String(val).trim().toLowerCase();
  const aliases = {
    user: "worker",
    users: "worker",
    worker: "worker",
    "group leader": "group-leader",
    groupleader: "group-leader",
    "project manager": "project-manager",
    projectmanager: "project-manager",
    "super admin": "superadmin",
    "super-admin": "superadmin",
  };
  const out = aliases[v] || v;
  return ROLE_ENUM.includes(out) ? out : "worker";
}

/** Normalize global role (superadmin/support/null) */
function normalizeGlobalRole(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim().toLowerCase();
  if (s === "super-admin") return "superadmin";
  return GLOBAL_ROLE_ENUM.includes(s) ? s : null;
}

/** Keep single role and roles[] in sync (role is canonical) */
function syncRoleFields(doc) {
  // Pick a primary from role or first roles[] entry, then normalize
  const primary = normalizeRole(
    doc.role ||
      (Array.isArray(doc.roles) && doc.roles.length > 0
        ? doc.roles[0]
        : "worker"),
  );

  doc.role = primary;
  doc.roles = [primary];
}

const PhotoSubSchema = new Schema(
  {
    // existing (legacy / user upload flow)
    objectId: { type: String, trim: true }, // storage key/id (no raw image here)
    url: { type: String, trim: true }, // optional signed URL placeholder
    uploadedBy: { type: Schema.Types.ObjectId, ref: "User" },
    uploadedAt: { type: Date },
    deviceId: { type: String, trim: true },
    hash: { type: String, trim: true }, // optional content hash

    // ✅ NEW (mobileOffline/GridFS profile pointer)
    fileId: { type: Schema.Types.ObjectId }, // GridFS file id (mobileOffline.files _id)
    source: { type: String, trim: true }, // e.g. "biometric-request", "admin-upload", etc.
    updatedAt: { type: Date },
  },
  { _id: false },
);

const BiometricSummarySubSchema = new Schema(
  {
    status: {
      type: String,
      enum: [
        "not-enrolled",
        "pending",
        "enrolled",
        "rejected",
        "revoked",
        "expired",
      ],
      default: "not-enrolled",
      index: true,
    },
    templateVersion: { type: String, trim: true }, // e.g., "face-emb-v1"
    lastLivenessScore: { type: Number },
    lastUpdatedAt: { type: Date },
  },
  { _id: false },
);

const UserSchema = new Schema(
  {
    orgId: {
      type: Schema.Types.ObjectId,
      ref: "Org",
      required: true,
      index: true,
    },

    name: { type: String, trim: true },

    // Org-scoped identity fields (do not use global unique flags on the field)
    email: { type: String, lowercase: true, trim: true, sparse: true },
    username: { type: String, trim: true, sparse: true },

    // ✅ Add this (Firebase Auth identity link)
    firebaseUid: { type: String, trim: true, index: true },

    // New: Staff Number (org-scoped unique, optional)
    staffNumber: { type: String, trim: true, sparse: true },

    // Legacy single role (canonical uses "worker" as base)
    role: {
      type: String,
      enum: ROLE_ENUM,
      default: "worker",
      index: true,
      set: normalizeRole,
    },

    // Optional multi-role support for newer code paths
    roles: [
      {
        type: String,
        enum: ROLE_ENUM,
        set: normalizeRole,
      },
    ],

    // Global / cross-tenant role (for cockpit)
    globalRole: {
      type: String,
      enum: [...GLOBAL_ROLE_ENUM, null], // <-- allow null as valid enum value
      default: null,
      index: true,
      set: normalizeGlobalRole,
    },

    // Convenience boolean flag (used by admin.super etc.)
    isGlobalSuperadmin: {
      type: Boolean,
      default: false,
      index: true,
    },

    // New: Photo metadata (pointer only)
    photo: { type: PhotoSubSchema, default: undefined },

    // New: Biometric summary (sensitive templates live elsewhere)
    biometric: { type: BiometricSummarySubSchema, default: undefined },

    active: { type: Boolean, default: true, index: true },

    // Soft-delete
    isDeleted: { type: Boolean, default: false, index: true },

    // Auth
    passwordHash: { type: String },
    password: { type: String, select: false }, // transient plain password for hashing
  },
  {
    timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        delete ret.passwordHash;
        delete ret.password;
        return ret;
      },
    },
    toObject: { virtuals: true },
  },
);

/* ------------------------------ Indexes ------------------------------ */

UserSchema.index({ orgId: 1, role: 1 });
UserSchema.index({ orgId: 1, active: 1 });
UserSchema.index({ orgId: 1, "biometric.status": 1 });

// Org-scoped unique constraints (partial to allow nulls)
UserSchema.index(
  { orgId: 1, email: 1 },
  {
    unique: true,
    sparse: true,
    partialFilterExpression: { email: { $type: "string" } },
  },
);
UserSchema.index(
  { orgId: 1, username: 1 },
  {
    unique: true,
    sparse: true,
    partialFilterExpression: { username: { $type: "string" } },
  },
);
UserSchema.index(
  { orgId: 1, staffNumber: 1 },
  {
    unique: true,
    sparse: true,
    partialFilterExpression: { staffNumber: { $type: "string" } },
  },
);

UserSchema.index(
  { orgId: 1, firebaseUid: 1 },
  {
    unique: true,
    sparse: true,
    partialFilterExpression: { firebaseUid: { $type: "string" } },
  },
);

// Global indexes
UserSchema.index({ globalRole: 1 });
UserSchema.index({ isGlobalSuperadmin: 1 });

/* ------------------------------ Virtuals ------------------------------ */
// All groups this user belongs to (source of truth: Group.memberUserIds)
UserSchema.virtual("groups", {
  ref: "Group",
  localField: "_id",
  foreignField: "memberUserIds",
  justOne: false,
  options: { match: { isDeleted: false } },
});

/* ------------------------------- Hooks -------------------------------- */
// Hash plain `password` on save + keep role fields synced
UserSchema.pre("save", async function (next) {
  try {
    if (this.isModified("password") && this.password) {
      this.passwordHash = await bcrypt.hash(this.password, 12);
      this.password = undefined; // never persist plain password
    }
    // ensure role ⇄ roles sync (also normalizes any alias like "user")
    syncRoleFields(this);
    next();
  } catch (err) {
    next(err);
  }
});

// Support password & role changes via findOneAndUpdate
UserSchema.pre("findOneAndUpdate", async function (next) {
  try {
    const update = this.getUpdate() || {};

    // Password hashing from updates
    const pwd = update.password ?? (update.$set && update.$set.password);
    if (pwd) {
      const hash = await bcrypt.hash(pwd, 12);
      if (update.$set) {
        update.$set.passwordHash = hash;
        delete update.$set.password;
      } else {
        update.passwordHash = hash;
        delete update.password;
      }
    }

    // Normalize inbound role(s) on updates (so "user" won't trip enum)
    const setObj = update.$set || update;
    if (setObj.role != null) setObj.role = normalizeRole(setObj.role);
    if (Array.isArray(setObj.roles))
      setObj.roles = setObj.roles.map(normalizeRole);

    // Keep fields in sync
    if (setObj.role != null && (!setObj.roles || setObj.roles.length === 0)) {
      setObj.roles = [setObj.role];
    } else if (
      (setObj.role == null || setObj.role === "") &&
      Array.isArray(setObj.roles) &&
      setObj.roles.length > 0
    ) {
      setObj.role = setObj.roles[0];
    } else if (
      setObj.role != null &&
      Array.isArray(setObj.roles) &&
      setObj.roles.length > 0
    ) {
      setObj.role = setObj.roles[0];
    }

    // Ensure updatedAt moves even if timestamps option doesn’t catch it
    if (update.$set) update.$set.updatedAt = new Date();
    else update.updatedAt = new Date();

    this.setUpdate(update);
    next();
  } catch (err) {
    next(err);
  }
});

/* ------------------------------ Methods ------------------------------- */
UserSchema.methods.verifyPassword = async function (candidate) {
  if (!this.passwordHash) return false;
  return bcrypt.compare(candidate, this.passwordHash);
};

UserSchema.methods.isAdminLike = function () {
  return this.role === "admin" || this.role === "superadmin";
};

UserSchema.methods.isGlobalSuper = function () {
  return this.globalRole === "superadmin" || this.isGlobalSuperadmin === true;
};

/* ------------------------------- Export -------------------------------- */
const modelName = "User";
module.exports =
  mongoose.models[modelName] || mongoose.model(modelName, UserSchema);
