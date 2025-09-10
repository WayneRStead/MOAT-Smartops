// models/User.js
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const { Schema } = mongoose;

const ROLE_ENUM = ['worker', 'manager', 'admin', 'superadmin'];

const UserSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true, index: true },

    name: { type: String, trim: true },
    email: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
    username: { type: String, unique: true, sparse: true, trim: true },

    role: { type: String, enum: ROLE_ENUM, default: 'worker', index: true },
    active: { type: Boolean, default: true, index: true },

    // Soft-delete for consistency with other models (optional but useful)
    isDeleted: { type: Boolean, default: false, index: true },

    // Store hash here
    passwordHash: { type: String },

    // Temporary plain password (not persisted, used only before save)
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

// ---------- Indexes ----------
// Helpful org-scoped filters
UserSchema.index({ orgId: 1, role: 1 });
UserSchema.index({ orgId: 1, active: 1 });
// If you prefer org-scoped uniqueness for email/username, replace the single-field uniques
// above with these compound uniques (requires dropping existing unique indexes first):
// UserSchema.index({ orgId: 1, email: 1 }, { unique: true, sparse: true, partialFilterExpression: { email: { $type: 'string' } } });
// UserSchema.index({ orgId: 1, username: 1 }, { unique: true, sparse: true, partialFilterExpression: { username: { $type: 'string' } } });

// ---------- Virtuals ----------
// Virtual to populate all groups a user belongs to (source of truth: Group.memberUserIds)
UserSchema.virtual('groups', {
  ref: 'Group',
  localField: '_id',
  foreignField: 'memberUserIds',
  justOne: false,
  options: { match: { isDeleted: false } },
});

// ---------- Hooks ----------
// Pre-save hook: hash plain `password` if provided
UserSchema.pre('save', async function (next) {
  try {
    if (this.isModified('password') && this.password) {
      this.passwordHash = await bcrypt.hash(this.password, 12);
      this.password = undefined; // don’t store the plain password
    }
    next();
  } catch (err) {
    next(err);
  }
});

// Handle password updates via findOneAndUpdate as well
UserSchema.pre('findOneAndUpdate', async function (next) {
  try {
    const update = this.getUpdate() || {};
    // Support both direct and $set usage
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
    // Keep updatedAt fresh on updates
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

// ---------- Methods ----------
UserSchema.methods.verifyPassword = async function (candidate) {
  if (!this.passwordHash) return false;
  return bcrypt.compare(candidate, this.passwordHash);
};

// Convenience: treat admin-like roles uniformly in guards/middleware
UserSchema.methods.isAdminLike = function () {
  return this.role === 'admin' || this.role === 'superadmin';
};

module.exports = mongoose.model('User', UserSchema);
