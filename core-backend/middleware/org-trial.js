// core-backend/middleware/org-trial.js

const ALLOWED_DURING_SUSPENSION = [
  "/api/org/billing",
  "/api/org/billing/",
  "/api/org/billing/preview",
  "/api/org/settings",
  "/org/billing",
  "/org/settings"
];

module.exports = async function enforceTrial(req, res, next) {
  try {
    const org = req.org; 
    if (!org) return next();

    // Allow billing + org settings even if suspended or trial expired
    const path = req.path || "";
    const allow = ALLOWED_DURING_SUSPENSION.some(p => path.startsWith(p));
    if (allow) return next();

    // Active trial check
    if (org.status === "trialing" && org.planCode === "trial") {
      if (org.trialEndsAt && org.trialEndsAt.getTime() < Date.now()) {
        // Trial expired → suspend + block feature routes
        org.status = "suspended";
        await org.save();

        return res.status(402).json({
          error: "Your trial has expired. Please upgrade to continue.",
          code: "TRIAL_EXPIRED",
        });
      }
    }

    next();
  } catch (e) {
    next(e);
  }
};
