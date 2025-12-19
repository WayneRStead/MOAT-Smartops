const mongoose = require("mongoose");
const OrgSchema = new mongoose.Schema({
  name: { type: String, required: true },
  slug: { type: String, index: true, unique: true },
  ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  status: { type: String, default: "active" }, // or 'trialing', 'suspended'
  settings: { type: Object, default: {} },
}, { timestamps: true });

module.exports = mongoose.model("Organization", OrgSchema);
