// routes/documents-extra.js (or extend existing)
router.get('/folders/list', requireAuth, async (req, res, next) => {
  try {
    const rows = await Document.aggregate([
      { $match: { deletedAt: { $exists: false } } },
      { $group: { _id: '$folder', count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]);
    res.json(rows.map(r => ({ folder: r._id || '', count: r.count })));
  } catch (e) { next(e); }
});
