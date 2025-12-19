const mongoose = require("mongoose");
const SubscriptionSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", index: true },
  plan: { type: String, default: "trial" },
  seats: { type: Number, default: 3 },
  status: { type: String, default: "trialing" },
  trialEndsAt: Date,
  stripeCustomerId: String,
  stripeSubId: String,
}, { timestamps: true });
module.exports = mongoose.model("Subscription", SubscriptionSchema);
