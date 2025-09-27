// core-backend/models/User.js
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const { Schema } = mongoose;

const ROLE_ENUM = ['worker', 'manager', 'admin', 'superadmin'];

const UserSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true, index: true },

    name: { type: String, trim: true },

    // We keep these globally unique+sparse by default.
    // If you need org-scoped uniqueness, see the compound indexes below.
    email: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
    username: { type: String, unique: true, sparse: true, trim: true },

    role: { type: String, enum: ROLE_ENUM, default: 'worker', index: true },
    active: { type: Boolean, default: true, index: true },

    // Soft-delete (keep historical refs consistent)
    isDeleted: { type: Boolean, default: false, index: true },

    // Store bcrypt hash here
    passwordHash: { type: String },

    // Temporary plain password (only used to set passwordHash in hooks)
    password: { type: String, select: false },
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        delete ret.passwordHash;
        delete ret.password;
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

/* ------------------------------ Indexes ------------------------------ */

// Helpful org-scoped filters
UserSchema.index({ orgId: 1, role: 1 });
UserSchema.index({ orgId: 1, active: 1 });

// If you prefer org-scoped uniqueness for email/username, use these INSTEAD of the single-field uniques above.
// ⚠️ You must first drop existing unique indexes on email/username if they already exist.
// UserSchema.index(
//   { orgId: 1, email: 1 },
//   { unique: true, sparse: true, partialFilterExpression: { email: { $type: 'string' } } }
// );
// UserSchema.index(
//   { orgId: 1, username: 1 },
//   { unique: true, sparse: true, partialFilterExpression: { username: { $type: 'string' } } }
// );

/* ------------------------------ Virtuals ------------------------------ */
// All groups this user belongs to (source of truth: Group.memberUserIds)
UserSchema.virtual('groups', {
  ref: 'Group',
  localField: '_id',
  foreignField: 'memberUserIds',
  justOne: false,
  options: { match: { isDeleted: false } },
});

/* ------------------------------- Hooks -------------------------------- */
// Hash plain `password` on save
UserSchema.pre('save', async function (next) {
  try {
    if (this.isModified('password') && this.password) {
      this.passwordHash = await bcrypt.hash(this.password, 12);
      this.password = undefined; // don't persist the plain field
    }
    next();
  } catch (err) {
    next(err);
  }
});

// Support password changes via findOneAndUpdate
UserSchema.pre('findOneAndUpdate', async function (next) {
  try {
    const update = this.getUpdate() || {};
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
      this.setUpdate(update);
    }
    // Timestamps option usually handles updatedAt, but keep a belt-and-braces update:
    if (update.$set) {
      update.$set.updatedAt = new Date();
    } else {
      update.updatedAt = new Date();
    }
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
  return this.role === 'admin' || this.role === 'superadmin';
};

/* ------------------------------- Export -------------------------------- */
// Guard to prevent OverwriteModelError across hot reloads / mixed imports
const modelName = 'User';
module.exports = mongoose.models[modelName] || mongoose.model(modelName, UserSchema);
