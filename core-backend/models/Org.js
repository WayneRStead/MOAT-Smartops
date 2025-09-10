const mongoose = require('mongoose');

const ModulesSchema = new mongoose.Schema(
  {
    projects:   { type: Boolean, default: true },
    tasks:      { type: Boolean, default: true }, 
    users:      { type: Boolean, default: true },
    clockings:  { type: Boolean, default: true },
    assets:     { type: Boolean, default: true },
    vehicles:   { type: Boolean, default: true },
    invoices:   { type: Boolean, default: false },
    inspections:{ type: Boolean, default: true },
    vault:      { type: Boolean, default: true },
  },
  { _id: false }
);

const ThemeLegacySchema = new mongoose.Schema(
  {
    mode:  { type: String, enum: ['light','dark','system'], default: 'system' },
    color: { type: String, default: '#2a7fff' },
  },
  { _id: false }
);

const OrgSchema = new mongoose.Schema(
  {
    name:        { type: String, default: 'Your Organization' },
    logoUrl:     { type: String, default: '' },

    // canonical
    themeMode:   { type: String, enum: ['light','dark','system'], default: 'system' },
    accentColor: { type: String, default: '#2a7fff' },

    // legacy (kept in sync)
    theme:       { type: ThemeLegacySchema, default: () => ({ mode: 'system', color: '#2a7fff' }) },

    modules:     { type: ModulesSchema, default: () => ({}) },
  },
  { timestamps: true }
);

OrgSchema.pre('save', function(next){
  if (!this.theme) this.theme = {};
  if (this.isModified('themeMode'))   this.theme.mode  = this.themeMode;
  if (this.isModified('accentColor')) this.theme.color = this.accentColor;
  next();
});

module.exports = mongoose.model('Org', OrgSchema);
