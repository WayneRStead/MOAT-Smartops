// utils/usage.js
exports.emitUsage = (event, payload) => {
  // For now just persist a UsageEvent; later roll into billing aggregation
  UsageEvent.create({ event, payload, at: new Date() }).catch(()=>{});
};
