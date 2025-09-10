const express = require('express');
const Invoice = require('../models/Invoice');
const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const rows = await Invoice.find().sort({ createdAt: -1 }).lean();
    res.json(rows);
  } catch (e) { next(e); }
});

module.exports = router;
