// core-backend/models/Trip.js
// Alias for backward compatibility. Always resolve to the VehicleTrip model.
const mongoose = require('mongoose');

let VehicleTrip;
try {
  // If VehicleTrip is already registered, reuse it.
  VehicleTrip = mongoose.model('VehicleTrip');
} catch {
  // If not registered yet, require the schema file and register it.
  // Your VehicleTrip.js should export a Mongoose model already; in case it exports
  // { schema, ... } we handle that too.
  const maybe = require('./VehicleTrip');
  if (maybe?.schema) {
    VehicleTrip = mongoose.models.VehicleTrip || mongoose.model('VehicleTrip', maybe.schema);
  } else {
    VehicleTrip = maybe; // already a model
  }
}

// Export the same model instance under the old name for callers that do require('models/Trip')
module.exports = VehicleTrip;
