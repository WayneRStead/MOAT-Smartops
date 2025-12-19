// core-backend/models/InspectionForm.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

// Treat "", null, undefined as "not set" so Mongoose won't try to cast to ObjectId.
function emptyToUndefined(v) {
  if (v === '' || v === null || v === undefined) return undefined;
  return v;
}

/* ----------------------------- Item ----------------------------- */
/* IMPORTANT: keep subdocument _id so items have a stable id used by the runner. */
const ItemSchema = new Schema(
  {
    label: { type: String, required: true, trim: true },
    allowPhoto: { type: Boolean, default: false },
    allowScan: { type: Boolean, default: false },
    allowNote: { type: Boolean, default: true },
    requireEvidenceOnFail: { type: Boolean, default: false },
    requireCorrectiveOnFail: { type: Boolean, default: true },
    criticalOnFail: { type: Boolean, default: false },
  },
  { _id: true } // <= ensure each item has an _id
);

/* ----------------------------- Scope ----------------------------- */
const ScopeSchema = new Schema(
  {
    type: { type: String, enum: ['global', 'scoped'], default: 'global' },

    // IMPORTANT: the custom setter prevents "" from being cast to ObjectId
    projectId: {
      type: Schema.Types.ObjectId,
      ref: 'Project',
      set: emptyToUndefined,
      default: undefined,
    },
    taskId: {
      type: Schema.Types.ObjectId,
      ref: 'Task',
      set: emptyToUndefined,
      default: undefined,
    },
    milestoneId: {
      type: Schema.Types.ObjectId,
      ref: 'TaskMilestone',
      set: emptyToUndefined,
      default: undefined,
    },

    // Optional denormalized labels (nice for read views)
    projectName: { type: String },
    taskName: { type: String },
    milestoneName: { type: String },
  },
  { _id: false }
);

/* ----------------------------- Scoring ----------------------------- */
const ScoringSchema = new Schema(
  {
    // 'any-fail' (default) | 'tolerance' | 'percent'
    mode: {
      type: String,
      enum: ['any-fail', 'tolerance', 'percent'],
      default: 'any-fail',
    },
    // used when mode = 'tolerance'
    maxNonCriticalFails: { type: Number, default: 0 },
    // used when mode = 'percent' (0..100)
    minPassPercent: { type: Number, default: 100 },
  },
  { _id: false }
);

/* ----------------------------- Subject (Vehicle/Asset/Performance) ----------------------------- */
const SubjectSchema = new Schema(
  {
    // none | vehicle | asset | performance
    type: {
      type: String,
      enum: ['none', 'vehicle', 'asset', 'performance'],
      default: 'none',
    },
    // If the form is locked to a particular item (ObjectId or string id).
    // For performance, this could be a specific user id if you ever want to lock a form to a person.
    lockToId: { type: Schema.Types.Mixed, set: emptyToUndefined, default: undefined },
    // Denormalized friendly label for the locked subject (optional)
    lockLabel: { type: String, default: '' },
  },
  { _id: false }
);

/* ----------------------------- Manager Comments (on the FORM) ----------------------------- */
const ManagerCommentSchema = new Schema(
  {
    comment: { type: String, required: true },
    at: { type: Date, default: Date.now },
    by: {
      _id: { type: Schema.Types.ObjectId, ref: 'User' },
      name: String,
      role: String,
      email: String,
    },
  },
  { _id: false }
);

/* ----------------------------- Form ----------------------------- */
const InspectionFormSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, index: true }, // multi-tenant guard (router enforces)
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    formType: { type: String, enum: ['standard', 'signoff'], default: 'standard' },

    scope: { type: ScopeSchema, default: () => ({ type: 'global' }) },

    // Who can run this form (empty => everyone)
    rolesAllowed: { type: [String], default: [] },

    // What is being inspected (vehicle/asset/performance/none) and whether it's locked to a specific item
    subject: { type: SubjectSchema, default: () => ({ type: 'none' }) },

    // Overall scoring rule
    scoring: {
      type: ScoringSchema,
      default: () => ({ mode: 'any-fail', maxNonCriticalFails: 0, minPassPercent: 100 }),
    },

    items: { type: [ItemSchema], default: [] },

    // Project Manager comment thread stored on the form definition
    managerComments: { type: [ManagerCommentSchema], default: undefined },

    // Optional author/last editor (routes can set these)
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },

    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

/* helpful indexes */
InspectionFormSchema.index({ title: 'text', description: 'text' });
InspectionFormSchema.index({ orgId: 1, updatedAt: -1 });
InspectionFormSchema.index({ isDeleted: 1, updatedAt: -1 });

/* ----------------------------- Pre-validate normalization ----------------------------- */
// Defensive cleanup before validation so "global" never carries blank ids and scoring/subject are sane.
InspectionFormSchema.pre('validate', function (next) {
  try {
    // Scope
    if (!this.scope) this.scope = { type: 'global' };

    if (this.scope.type !== 'scoped') {
      // Global: ensure ids are not present (avoid ObjectId casts)
      this.scope.projectId = undefined;
      this.scope.taskId = undefined;
      this.scope.milestoneId = undefined;
    } else {
      // Scoped: coerce blanks to undefined (the setters also handle this)
      this.scope.projectId = emptyToUndefined(this.scope.projectId);
      this.scope.taskId = emptyToUndefined(this.scope.taskId);
      this.scope.milestoneId = emptyToUndefined(this.scope.milestoneId);
    }

    // Roles
    if (!Array.isArray(this.rolesAllowed)) this.rolesAllowed = [];
    this.rolesAllowed = this.rolesAllowed
      .map((r) => (r == null ? '' : String(r).trim()))
      .filter(Boolean);

    // Subject
    if (!this.subject) this.subject = { type: 'none' };
    const validSubject = ['none', 'vehicle', 'asset', 'performance'];
    if (!validSubject.includes(this.subject.type)) this.subject.type = 'none';

    if (this.subject.type === 'none') {
      this.subject.lockToId = undefined;
      this.subject.lockLabel = '';
    } else {
      this.subject.lockToId = emptyToUndefined(this.subject.lockToId);
      if (typeof this.subject.lockLabel !== 'string') this.subject.lockLabel = '';
    }

    // Scoring
    if (!this.scoring) {
      this.scoring = { mode: 'any-fail', maxNonCriticalFails: 0, minPassPercent: 100 };
    } else {
      const validModes = ['any-fail', 'tolerance', 'percent'];
      if (!validModes.includes(this.scoring.mode)) this.scoring.mode = 'any-fail';

      const mF = Number(this.scoring.maxNonCriticalFails);
      this.scoring.maxNonCriticalFails = Number.isFinite(mF) && mF > 0 ? Math.floor(mF) : 0;

      const pct = Number(this.scoring.minPassPercent);
      if (!Number.isFinite(pct)) this.scoring.minPassPercent = 100;
      else this.scoring.minPassPercent = Math.max(0, Math.min(100, Math.floor(pct)));
    }

    next();
  } catch (e) {
    next(e);
  }
});

module.exports =
  mongoose.models.InspectionForm ||
  mongoose.model('InspectionForm', InspectionFormSchema);
