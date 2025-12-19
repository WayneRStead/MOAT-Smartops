const mongoose = require('mongoose');
module.exports = (param='id') => (req, res, next) => {
  const val = String(req.params[param] || '');
  if (!mongoose.Types.ObjectId.isValid(val)) {
    return res.status(400).json({ error: `invalid ${param}` });
  }
  next();
};
