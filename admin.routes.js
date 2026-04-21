const express = require('express');
const router = express.Router();

/* ============================
   REQUIRE ADMIN
============================ */
function requireAdmin(req, res, next) {
  if (!req.session || !req.session.user || !req.session.user.is_admin) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }
  next();
}

/* ============================
   PING
============================ */
router.get('/ping', requireAdmin, (req, res) => {
  res.json({ ok: true });
});

/* ============================
   STATS
============================ */
router.get('/stats', requireAdmin, async (req, res) => {
  try {
    const pool = req.app.get('pool');

    const usersToday = await pool.query(
      `SELECT COUNT(*) FROM users WHERE created_at::date = CURRENT_DATE`
    );

    const adsToday = await pool.query(
      `SELECT COUNT(*) FROM ads WHERE created_at::date = CURRENT_DATE`
    );

    const pendingAds = await pool.query(
      `SELECT COUNT(*) FROM ads WHERE status = 'pending'`
    );

    res.json({
      usersToday: Number(usersToday.rows[0].count),
      adsToday: Number(adsToday.rows[0].count),
      pendingAds: Number(pendingAds.rows[0].count),
      openReports: 0,
      premiumMonth: 0
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

/* ============================
   USERS LIST
============================ */
router.get('/users', requireAdmin, async (req, res) => {
  try {
    const pool = req.app.get('pool');
    const limit = Number(req.query.limit || 20);

    const result = await pool.query(
      `SELECT id, name, email, role, status
       FROM users
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );

    res.json({ items: result.rows });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

/* ============================
   ADS LIST
============================ */
router.get('/ads', requireAdmin, async (req, res) => {
  try {
    const pool = req.app.get('pool');
    const limit = Number(req.query.limit || 20);

    const result = await pool.query(
      `SELECT id, title, status, user_id as "ownerId"
       FROM ads
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );

    res.json({ items: result.rows });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

/* ============================
   UPDATE AD STATUS
============================ */
router.patch('/ads/:id/status', requireAdmin, async (req, res) => {
  try {
    const pool = req.app.get('pool');
    const { id } = req.params;
    const { status } = req.body;

    await pool.query(
      `UPDATE ads SET status = $1 WHERE id = $2`,
      [status, id]
    );

    res.json({ ok: true });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

/* ============================
   DELETE AD
============================ */
router.delete('/ads/:id', requireAdmin, async (req, res) => {
  try {
    const pool = req.app.get('pool');
    const { id } = req.params;

    await pool.query(`DELETE FROM ads WHERE id = $1`, [id]);

    res.json({ ok: true });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

module.exports = router;