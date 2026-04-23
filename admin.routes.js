// admin.routes.js  (Samsar Admin API - Postgres)
// حط هاد الملف حدّ server.js واستعمل:
// const adminRoutes = require('./admin.routes'); app.use('/api/admin', adminRoutes);

const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const multer = require('multer');
const crypto = require('crypto');

let defaultDb = {};
try { defaultDb = require('./db'); } catch (_) { defaultDb = {}; }

const router = express.Router();

/* ============================
   HELPERS
============================ */
function getPool(req) {
  return req.app.get('pool') || defaultDb.pool;
}
function isAdminSession(req) {
  return !!(req.session && req.session.user && req.session.user.is_admin);
}
function requireAdmin(req, res, next) {
  if (!isAdminSession(req)) return res.status(401).json({ error: 'UNAUTHORIZED' });
  next();
}
function toInt(v, d = 0) {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : d;
}
function toBool(v) {
  return v === true || v === 'true' || v === '1' || v === 1;
}
function nowISO() {
  return new Date().toISOString();
}
async function hasTable(pool, table) {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name=$1 LIMIT 1`,
    [table]
  );
  return !!r.rows[0];
}
async function hasColumn(pool, table, col) {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2 LIMIT 1`,
    [table, col]
  );
  return !!r.rows[0];
}

/* ============================
   UPLOADS (slides/media)
============================ */
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const base = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, base + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 1024 * 1024 * 50 } }); // 50MB

function fileUrl(file) {
  if (!file) return null;
  return '/uploads/' + file.filename;
}

// مهم: باش يخدم JSON ولا multipart فـ نفس endpoint
function maybeUploadSingle(field) {
  const mw = upload.single(field);
  return (req, res, next) => {
    const ct = String(req.headers['content-type'] || '');
    if (ct.includes('multipart/form-data')) return mw(req, res, next);
    return next();
  };
}

/* ============================
   SCHEMA ENSURE
   (كيكمّل غير الجداول اللي ناقصين، وما كيخرّبش الموجودين)
============================ */
let schemaReady = false;

async function ensureSchema(req) {
  if (schemaReady) return;
  const pool = getPool(req);
  if (!pool) throw new Error('POOL_MISSING');

  // Audit logs
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_audit_logs(
      id BIGSERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      admin_id TEXT,
      target_id TEXT,
      meta JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Settings (إذا ما كانتش موجودة، كنصايبوها)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings(
      id INT PRIMARY KEY,
      platform_name TEXT,
      subtitle TEXT,
      logo_url TEXT,
      support_whatsapp TEXT,
      support_email TEXT,
      support_telegram TEXT,
      allow_register BOOLEAN DEFAULT true,
      max_images INT DEFAULT 6,
      max_image_mb INT DEFAULT 10,
      max_video_mb INT DEFAULT 1024,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`INSERT INTO settings(id) VALUES (1) ON CONFLICT (id) DO NOTHING;`);

  // Home banner settings + sections
  await pool.query(`
    CREATE TABLE IF NOT EXISTS home_banner_settings(
      id INT PRIMARY KEY DEFAULT 1,
      autoplay BOOLEAN NOT NULL DEFAULT true,
      interval INT NOT NULL DEFAULT 4000,
      dots BOOLEAN NOT NULL DEFAULT true,
      max_slides INT NOT NULL DEFAULT 10,
      show_featured BOOLEAN NOT NULL DEFAULT true,
      featured_limit INT NOT NULL DEFAULT 8,
      show_latest BOOLEAN NOT NULL DEFAULT true,
      latest_limit INT NOT NULL DEFAULT 12,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`INSERT INTO home_banner_settings(id) VALUES (1) ON CONFLICT (id) DO NOTHING;`);

  // Quick categories
  await pool.query(`
    CREATE TABLE IF NOT EXISTS home_quick_categories(
      id INT PRIMARY KEY DEFAULT 1,
      keys TEXT[] NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`INSERT INTO home_quick_categories(id) VALUES (1) ON CONFLICT (id) DO NOTHING;`);

  // Home slides (كانت ناقصة عند بزاف الناس)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS home_slides(
      id UUID PRIMARY KEY,
      image_url TEXT NOT NULL,
      link_url TEXT,
      ord INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Verification
  await pool.query(`
    CREATE TABLE IF NOT EXISTS verification_settings(
      id INT PRIMARY KEY DEFAULT 1,
      enabled BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`INSERT INTO verification_settings(id) VALUES (1) ON CONFLICT (id) DO NOTHING;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS verification_requests(
      id UUID PRIMARY KEY,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      docs_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Notifications (إلا ماكانت)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications(
      id UUID PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      read BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notification_templates(
      key TEXT PRIMARY KEY,
      title TEXT,
      body TEXT,
      json JSONB,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Reports
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reports(
      id UUID PRIMARY KEY,
      user_id TEXT,
      ad_id UUID,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Support FAQ
  await pool.query(`
    CREATE TABLE IF NOT EXISTS support_faq(
      id UUID PRIMARY KEY,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true,
      ord INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Premium
  await pool.query(`
    CREATE TABLE IF NOT EXISTS premium_plans(
      key TEXT PRIMARY KEY,
      price INT NOT NULL DEFAULT 0,
      days INT NOT NULL DEFAULT 0,
      benefits TEXT,
      active BOOLEAN NOT NULL DEFAULT true,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Premium orders (باش /stats ما يطيحش + admin page)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS premium_orders(
      id UUID PRIMARY KEY,
      user_id TEXT,
      ad_id UUID,
      plan TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  schemaReady = true;
}

async function audit(req, type, targetId = null, meta = null) {
  try {
    const pool = getPool(req);
    if (!pool) return;
    const adminId = req.session?.user?.id || null;
    await pool.query(
      `INSERT INTO admin_audit_logs(type, admin_id, target_id, meta) VALUES($1,$2,$3,$4)`,
      [type, adminId, targetId, meta ? JSON.stringify(meta) : null]
    );
  } catch (_) {}
}

/* ============================
   PING
============================ */
router.get('/ping', requireAdmin, async (req, res) => {
  res.json({ ok: true, time: nowISO() });
});

/* ============================
   STATS
============================ */
router.get('/stats', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);

    const usersToday = await pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE created_at::date = CURRENT_DATE`).catch(() => ({ rows:[{n:0}] }));
    const adsToday = await pool.query(`SELECT COUNT(*)::int AS n FROM ads WHERE created_at::date = CURRENT_DATE`).catch(() => ({ rows:[{n:0}] }));
    const pendingAds = await pool.query(`SELECT COUNT(*)::int AS n FROM ads WHERE status = 'pending'`).catch(() => ({ rows:[{n:0}] }));
    const openReports = await pool.query(`SELECT COUNT(*)::int AS n FROM reports WHERE status = 'open'`).catch(() => ({ rows:[{n:0}] }));
    const premiumMonth = await pool.query(`
      SELECT COUNT(*)::int AS n
      FROM premium_orders
      WHERE date_trunc('month', created_at) = date_trunc('month', now())
    `).catch(() => ({ rows: [{ n: 0 }] }));

    res.json({
      usersToday: usersToday.rows[0]?.n ?? 0,
      adsToday: adsToday.rows[0]?.n ?? 0,
      pendingAds: pendingAds.rows[0]?.n ?? 0,
      openReports: openReports.rows[0]?.n ?? 0,
      premiumMonth: premiumMonth.rows[0]?.n ?? 0
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

/* ============================
   LOGS (Audit)
============================ */
router.get('/logs', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const limit = Math.min(toInt(req.query.limit, 50), 200);
    const type = String(req.query.type || '').trim();

    const params = [];
    let where = '1=1';
    let i = 1;
    if (type) { where += ` AND type ILIKE $${i}`; params.push(`%${type}%`); i++; }

    const r = await pool.query(
      `SELECT type, admin_id as "adminId", target_id as "targetId", created_at as "createdAt"
       FROM admin_audit_logs
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT ${limit}`,
      params
    );

    res.json({ items: r.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

/* ============================
   SETTINGS
============================ */
router.get('/settings', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);

    const r = await pool.query(`SELECT * FROM settings WHERE id=1`);
    const s = r.rows[0] || {};

    res.json({
      platformName: s.platform_name || '',
      subtitle: s.subtitle || '',
      logoUrl: s.logo_url || '',
      supportWhatsapp: s.support_whatsapp || '',
      supportEmail: s.support_email || '',
      supportTelegram: s.support_telegram || '',
      allowRegister: s.allow_register === true,
      uploads: {
        maxImages: s.max_images ?? 6,
        maxImageMb: s.max_image_mb ?? 10,
        maxVideoMb: s.max_video_mb ?? 1024
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

router.put('/settings', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const b = req.body || {};

    await pool.query(
      `UPDATE settings SET
        platform_name = COALESCE($1, platform_name),
        subtitle = COALESCE($2, subtitle),
        logo_url = COALESCE($3, logo_url),
        support_whatsapp = COALESCE($4, support_whatsapp),
        support_email = COALESCE($5, support_email),
        support_telegram = COALESCE($6, support_telegram),
        updated_at = NOW()
       WHERE id=1`,
      [
        (b.platformName ?? null) || null,
        (b.subtitle ?? null) || null,
        (b.logoUrl ?? null) || null,
        (b.supportWhatsapp ?? null) || null,
        (b.supportEmail ?? null) || null,
        (b.supportTelegram ?? null) || null
      ]
    );

    await audit(req, 'settings.update', 'settings:1', { keys: Object.keys(b || {}) });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

router.put('/settings/uploads', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const b = req.body || {};

    const maxImages = b.uploads?.maxImages;
    const maxImageMb = b.uploads?.maxImageMb;
    const maxVideoMb = b.uploads?.maxVideoMb;
    const allowRegister = typeof b.allowRegister === 'boolean' ? b.allowRegister : null;

    await pool.query(
      `UPDATE settings SET
        allow_register = COALESCE($1, allow_register),
        max_images = COALESCE($2, max_images),
        max_image_mb = COALESCE($3, max_image_mb),
        max_video_mb = COALESCE($4, max_video_mb),
        updated_at = NOW()
       WHERE id=1`,
      [allowRegister, maxImages ?? null, maxImageMb ?? null, maxVideoMb ?? null]
    );

    await audit(req, 'settings.uploads', 'settings:1', { uploads: b.uploads, allowRegister });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

/* ============================
   HOME - Banner Settings / Sections / Quick Categories
============================ */
router.get('/home/banner-settings', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const r = await pool.query(`SELECT * FROM home_banner_settings WHERE id=1`);
    const b = r.rows[0] || {};
    res.json({ autoplay: b.autoplay, interval: b.interval, dots: b.dots, maxSlides: b.max_slides });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

router.put('/home/banner-settings', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const b = req.body || {};

    await pool.query(
      `UPDATE home_banner_settings SET
        autoplay = COALESCE($1, autoplay),
        interval = COALESCE($2, interval),
        dots = COALESCE($3, dots),
        max_slides = COALESCE($4, max_slides),
        updated_at = NOW()
       WHERE id=1`,
      [
        typeof b.autoplay === 'boolean' ? b.autoplay : null,
        Number.isFinite(+b.interval) ? +b.interval : null,
        typeof b.dots === 'boolean' ? b.dots : null,
        Number.isFinite(+b.maxSlides) ? +b.maxSlides : null
      ]
    );

    await audit(req, 'home.banner_settings', 'home_banner_settings:1', b);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

router.get('/home/sections', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const r = await pool.query(`SELECT * FROM home_banner_settings WHERE id=1`);
    const s = r.rows[0] || {};
    res.json({
      showFeatured: s.show_featured,
      featuredLimit: s.featured_limit,
      showLatest: s.show_latest,
      latestLimit: s.latest_limit
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

router.put('/home/sections', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const b = req.body || {};

    await pool.query(
      `UPDATE home_banner_settings SET
        show_featured = COALESCE($1, show_featured),
        featured_limit = COALESCE($2, featured_limit),
        show_latest = COALESCE($3, show_latest),
        latest_limit = COALESCE($4, latest_limit),
        updated_at = NOW()
       WHERE id=1`,
      [
        typeof b.showFeatured === 'boolean' ? b.showFeatured : null,
        Number.isFinite(+b.featuredLimit) ? +b.featuredLimit : null,
        typeof b.showLatest === 'boolean' ? b.showLatest : null,
        Number.isFinite(+b.latestLimit) ? +b.latestLimit : null
      ]
    );

    await audit(req, 'home.sections', 'home_banner_settings:1', b);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

router.get('/home/quick-categories', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const r = await pool.query(`SELECT keys FROM home_quick_categories WHERE id=1`);
    res.json({ keys: r.rows[0]?.keys || [] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

router.put('/home/quick-categories', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const keys = Array.isArray(req.body?.keys) ? req.body.keys.map(x => String(x).trim()).filter(Boolean) : [];

    await pool.query(`UPDATE home_quick_categories SET keys=$1, updated_at=NOW() WHERE id=1`, [keys]);

    await audit(req, 'home.quick_categories', 'home_quick_categories:1', { keys });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

/* ============================
   HOME SLIDES
   - JSON: {imageUrl, linkUrl, order}
   - multipart: field "image"
============================ */
router.get('/home/slides', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);

    const r = await pool.query(`SELECT id, image_url, link_url, ord, created_at FROM home_slides ORDER BY ord ASC, created_at DESC`);
    res.json({
      items: r.rows.map(x => ({
        id: x.id,
        imageUrl: x.image_url,
        linkUrl: x.link_url || '',
        order: x.ord ?? 0
      }))
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// مهم: maybeUploadSingle باش JSON ما يتحولش لـ {}
router.post('/home/slides', requireAdmin, maybeUploadSingle('image'), async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);

    const imageUrl = (req.body?.imageUrl || '').trim();
    const linkUrl = (req.body?.linkUrl || '').trim();
    const order = toInt(req.body?.order, 0);

    const img = fileUrl(req.file) || (imageUrl ? imageUrl : null);
    if (!img) return res.status(400).json({ error: 'NO_IMAGE' });

    const id = crypto.randomUUID();

    await pool.query(
      `INSERT INTO home_slides(id, image_url, link_url, ord, created_at)
       VALUES($1,$2,$3,$4,NOW())`,
      [id, img, linkUrl || null, order]
    );

    await audit(req, 'home.slide.create', id, { imageUrl: img, linkUrl, order });
    res.json({ ok: true, id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

router.delete('/home/slides/:id', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const id = req.params.id;

    await pool.query(`DELETE FROM home_slides WHERE id=$1`, [id]);

    await audit(req, 'home.slide.delete', id, null);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

/* ============================
   CATEGORIES CRUD
   (كيحاول مع columns: image_url + ord + active)
============================ */
router.get('/categories', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);

    const hasImageUrl = await hasColumn(pool, 'categories', 'image_url').catch(() => false);
    const hasOrd = await hasColumn(pool, 'categories', 'ord').catch(() => false);
    const hasActive = await hasColumn(pool, 'categories', 'active').catch(() => false);
    const hasCreatedAt = await hasColumn(pool, 'categories', 'created_at').catch(() => false);

    const r = await pool.query(`
      SELECT
        id,
        name,
        description
        ${hasImageUrl ? ', image_url' : ''}
        ${hasOrd ? ', ord' : ''}
        ${hasActive ? ', active' : ''}
        ${hasCreatedAt ? ', created_at' : ''}
      FROM categories
      ORDER BY ${hasOrd ? 'ord ASC,' : ''} ${hasCreatedAt ? 'created_at DESC' : 'id ASC'}
    `);

    res.json({
      items: r.rows.map(c => ({
        id: c.id,
        name: c.name,
        description: c.description || '',
        image: hasImageUrl ? (c.image_url || '') : '',
        order: hasOrd ? (c.ord ?? 0) : 0,
        active: hasActive ? !!c.active : true
      }))
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

router.post('/categories', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const b = req.body || {};

    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'name required' });

    // ✅ إذا categories.id UUID: كنولدو UUID
    // وإذا كانت TEXT: نقدر نستعمل b.id إلا كان جا
    let id = (b.id !== undefined && b.id !== null) ? String(b.id).trim() : '';
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
    if (!id || !isUuid) id = crypto.randomUUID();

    const hasImageUrl = await hasColumn(pool, 'categories', 'image_url').catch(() => false);
    const hasOrd = await hasColumn(pool, 'categories', 'ord').catch(() => false);
    const hasActive = await hasColumn(pool, 'categories', 'active').catch(() => false);
    const hasCreatedAt = await hasColumn(pool, 'categories', 'created_at').catch(() => false);

    const cols = ['id', 'name', 'description'];
    const vals = [id, name, String(b.description || '')];

    if (hasImageUrl) { cols.push('image_url'); vals.push(String(b.image || '') || null); }
    if (hasActive) { cols.push('active'); vals.push(toBool(b.active)); }
    if (hasOrd) { cols.push('ord'); vals.push(toInt(b.order, 0)); }
    if (hasCreatedAt) { cols.push('created_at'); vals.push(new Date()); }

    const ph = cols.map((_, idx) => `$${idx + 1}`).join(',');

    await pool.query(`INSERT INTO categories(${cols.join(',')}) VALUES(${ph})`, vals);

    await audit(req, 'categories.create', id, { name });
    res.json({ ok: true, id });
  } catch (e) {
    console.error('ADMIN CREATE CATEGORY ERROR:', e);
    res.status(500).json({ error: 'SERVER_ERROR', message: String(e.message || e) });
  }
});

router.put('/categories/:id', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const id = req.params.id;
    const b = req.body || {};

    const sets = [];
    const params = [id];
    let i = 2;

    if (b.name !== undefined) { sets.push(`name=$${i++}`); params.push(String(b.name).trim()); }
    if (b.description !== undefined) { sets.push(`description=$${i++}`); params.push(String(b.description)); }

    if (await hasColumn(pool, 'categories', 'image_url').catch(() => false)) {
      if (b.image !== undefined) { sets.push(`image_url=$${i++}`); params.push(String(b.image) || null); }
    }

    if (await hasColumn(pool, 'categories', 'active').catch(() => false)) {
      if (b.active !== undefined) { sets.push(`active=$${i++}`); params.push(toBool(b.active)); }
    }

    if (await hasColumn(pool, 'categories', 'ord').catch(() => false)) {
      if (b.order !== undefined) { sets.push(`ord=$${i++}`); params.push(toInt(b.order, 0)); }
    }

    if (await hasColumn(pool, 'categories', 'updated_at').catch(() => false)) {
      sets.push(`updated_at=NOW()`);
    }

    if (!sets.length) return res.json({ ok: true });

    await pool.query(`UPDATE categories SET ${sets.join(', ')} WHERE id=$1`, params);

    await audit(req, 'categories.update', id, b);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

router.delete('/categories/:id', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const id = req.params.id;

    await pool.query(`DELETE FROM categories WHERE id=$1`, [id]);

    await audit(req, 'categories.delete', id, null);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

/* ============================
   ADS (Admin)  ✅ FIXED FOR YOUR SCHEMA
   جدول ads عندك: category / city / owner_name / owner_email / owner_phone / featured / status ...
   ماكاينش user_id نهائياً
============================ */
router.get('/ads', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);

    const q = String(req.query.q || '').trim();
    const status = String(req.query.status || '').trim();
    const category = String(req.query.category || '').trim();
    const city = String(req.query.city || '').trim();
    const featured = String(req.query.featured || '').trim();
    const limit = Math.min(toInt(req.query.limit, 20), 100);

    const where = [];
    const params = [];
    let i = 1;

    // columns presence
    const hasDesc = await hasColumn(pool, 'ads', 'description').catch(() => false);
    const hasCategory = await hasColumn(pool, 'ads', 'category').catch(() => false);
    const hasCity = await hasColumn(pool, 'ads', 'city').catch(() => false);
    const hasFeatured = await hasColumn(pool, 'ads', 'featured').catch(() => false);
    const hasStatus = await hasColumn(pool, 'ads', 'status').catch(() => false);
    const hasOwnerEmail = await hasColumn(pool, 'ads', 'owner_email').catch(() => false);

    if (q) {
      const parts = [];
      parts.push(`a.title ILIKE $${i}`);
      if (hasDesc) parts.push(`a.description ILIKE $${i}`);
      if (hasOwnerEmail) parts.push(`a.owner_email ILIKE $${i}`);
      where.push(`(${parts.join(' OR ')})`);
      params.push(`%${q}%`);
      i++;
    }
    if (status && hasStatus) { where.push(`a.status = $${i}`); params.push(status); i++; }
    if (category && hasCategory) { where.push(`a.category = $${i}`); params.push(category); i++; }
    if (city && hasCity) { where.push(`a.city ILIKE $${i}`); params.push(city); i++; }
    if (hasFeatured) {
      if (featured === 'true') where.push(`a.featured = true`);
      if (featured === 'false') where.push(`a.featured = false`);
    }

    const ownerSelect = hasOwnerEmail ? `a.owner_email as "ownerId"` : `NULL as "ownerId"`;

    const r = await pool.query(
      `SELECT a.id, a.title
              ${hasStatus ? ', a.status' : ", 'published' as status"}
              ${hasFeatured ? ', a.featured' : ', false as featured'}
              , ${ownerSelect}
       FROM ads a
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY a.created_at DESC
       LIMIT ${limit}`,
      params
    );

    res.json({ items: r.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

router.patch('/ads/:id/status', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const id = req.params.id;
    const status = String(req.body?.status || '').trim();
    if (!status) return res.status(400).json({ error: 'VALIDATION_ERROR' });

    if (!(await hasColumn(pool, 'ads', 'status').catch(() => false))) {
      return res.status(400).json({ error: 'STATUS_COLUMN_MISSING' });
    }

    await pool.query(`UPDATE ads SET status=$1 WHERE id=$2`, [status, id]);
    await audit(req, 'ads.status', id, { status });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

router.patch('/ads/:id/feature', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const id = req.params.id;
    const featured = typeof req.body?.featured === 'boolean' ? req.body.featured : toBool(req.body?.featured);

    if (!(await hasColumn(pool, 'ads', 'featured').catch(() => false))) {
      return res.status(400).json({ error: 'FEATURED_COLUMN_MISSING' });
    }

    await pool.query(`UPDATE ads SET featured=$1 WHERE id=$2`, [featured, id]);
    await audit(req, 'ads.feature', id, { featured });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// ✅ FIXED: Change owner => update owner_name/owner_email/owner_phone (ماشي user_id)
router.patch('/ads/:id/owner', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const adId = req.params.id;
    const newUserId = String(req.body?.newUserId || '').trim();
    if (!newUserId) return res.status(400).json({ error: 'VALIDATION_ERROR' });

    const u = await pool.query(`SELECT id, name, email, phone FROM users WHERE id=$1`, [newUserId]);
    const user = u.rows[0];
    if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });

    const hasOwnerName = await hasColumn(pool, 'ads', 'owner_name').catch(() => false);
    const hasOwnerEmail = await hasColumn(pool, 'ads', 'owner_email').catch(() => false);
    const hasOwnerPhone = await hasColumn(pool, 'ads', 'owner_phone').catch(() => false);

    if (!hasOwnerName && !hasOwnerEmail && !hasOwnerPhone) {
      return res.status(400).json({ error: 'OWNER_COLUMNS_MISSING' });
    }

    const sets = [];
    const params = [adId];
    let i = 2;

    if (hasOwnerName) { sets.push(`owner_name=$${i++}`); params.push(user.name || ''); }
    if (hasOwnerEmail) { sets.push(`owner_email=$${i++}`); params.push(user.email || ''); }
    if (hasOwnerPhone) { sets.push(`owner_phone=$${i++}`); params.push(user.phone || ''); }

    await pool.query(`UPDATE ads SET ${sets.join(', ')} WHERE id=$1`, params);

    await audit(req, 'ads.owner', adId, { newUserId, owner_email: user.email });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

router.delete('/ads/:id', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const id = req.params.id;

    await pool.query(`DELETE FROM ads WHERE id=$1`, [id]);

    await audit(req, 'ads.delete', id, null);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

/* ============================
   USERS (Admin)
============================ */
router.get('/users', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);

    const q = String(req.query.q || '').trim();
    const role = String(req.query.role || '').trim();        // user/admin/moderator
    const status = String(req.query.status || '').trim();    // active/banned/disabled
    const verified = String(req.query.verified || '').trim();// true/false (optional)
    const limit = Math.min(toInt(req.query.limit, 20), 200);

    const where = [];
    const params = [];
    let i = 1;

    const hasPhone = await hasColumn(pool, 'users', 'phone').catch(() => false);
    const hasVerified = await hasColumn(pool, 'users', 'verified').catch(() => false);
    const hasDisabled = await hasColumn(pool, 'users', 'disabled').catch(() => false);
    const hasIsAdmin = await hasColumn(pool, 'users', 'is_admin').catch(() => false);

    if (q) {
      const parts = [`u.name ILIKE $${i}`, `u.email ILIKE $${i}`];
      if (hasPhone) parts.push(`u.phone ILIKE $${i}`);
      where.push(`(${parts.join(' OR ')})`);
      params.push(`%${q}%`);
      i++;
    }

    if (hasIsAdmin) {
      if (role === 'admin') where.push(`u.is_admin = true`);
      if (role === 'user' || role === 'moderator') where.push(`u.is_admin = false`);
    }

    if (hasDisabled) {
      if (status === 'active') where.push(`COALESCE(u.disabled,false) = false`);
      if (status === 'banned' || status === 'disabled') where.push(`COALESCE(u.disabled,false) = true`);
    }

    if (hasVerified) {
      if (verified === 'true') where.push(`COALESCE(u.verified,false) = true`);
      if (verified === 'false') where.push(`COALESCE(u.verified,false) = false`);
    }

    const r = await pool.query(
      `SELECT u.id, u.name, u.email
              ${hasPhone ? ', u.phone' : ", '' as phone"}
              ${hasIsAdmin ? `, CASE WHEN u.is_admin THEN 'admin' ELSE 'user' END as role` : `, 'user' as role`}
              ${hasDisabled ? `, CASE WHEN COALESCE(u.disabled,false) THEN 'banned' ELSE 'active' END as status` : `, 'active' as status`}
              ${hasVerified ? `, COALESCE(u.verified,false) as verified` : ``}
       FROM users u
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY u.created_at DESC
       LIMIT ${limit}`,
      params
    );

    res.json({ items: r.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

router.put('/users/:id', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const id = req.params.id;
    const b = req.body || {};

    const sets = [];
    const params = [id];
    let i = 2;

    if ((await hasColumn(pool, 'users', 'phone').catch(() => false)) && b.phone !== undefined) {
      sets.push(`phone=$${i++}`);
      params.push(String(b.phone).trim());
    }

    if ((await hasColumn(pool, 'users', 'is_admin').catch(() => false)) && b.role !== undefined) {
      const role = String(b.role).trim();
      let isAdmin = null;
      if (role === 'admin') isAdmin = true;
      if (role === 'user' || role === 'moderator') isAdmin = false;
      if (isAdmin !== null) {
        sets.push(`is_admin=$${i++}`);
        params.push(isAdmin);
      }
    }

    if (!sets.length) return res.json({ ok: true });

    await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id=$1`, params);

    await audit(req, 'users.update', id, b);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

router.patch('/users/:id/status', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const id = req.params.id;
    const status = String(req.body?.status || '').trim();
    if (!status) return res.status(400).json({ error: 'VALIDATION_ERROR' });

    if (!(await hasColumn(pool, 'users', 'disabled').catch(() => false))) {
      return res.status(400).json({ error: 'DISABLED_COLUMN_MISSING' });
    }

    const disabled = (status === 'banned' || status === 'disabled') ? true : false;
    await pool.query(`UPDATE users SET disabled=$1 WHERE id=$2`, [disabled, id]);

    await audit(req, 'users.status', id, { status });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

router.patch('/users/:id/verify', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const id = req.params.id;

    if (!(await hasColumn(pool, 'users', 'verified').catch(() => false))) {
      return res.json({ ok: true, note: 'verified_column_missing_ignored' });
    }

    const verified = typeof req.body?.verified === 'boolean' ? req.body.verified : toBool(req.body?.verified);
    await pool.query(`UPDATE users SET verified=$1 WHERE id=$2`, [verified, id]);

    await audit(req, 'users.verify', id, { verified });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

router.post('/users/:id/reset-password', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const id = req.params.id;
    const newPassword = String(req.body?.newPassword || '');
    if (newPassword.length < 6) return res.status(400).json({ error: 'WEAK_PASSWORD' });

    const hash = await bcrypt.hash(newPassword, 10);

    // بعض المشاريع كيسميوها password أو password_hash
    const hasPassword = await hasColumn(pool, 'users', 'password').catch(() => false);
    const hasPasswordHash = await hasColumn(pool, 'users', 'password_hash').catch(() => false);

    if (hasPassword) {
      await pool.query(`UPDATE users SET password=$1 WHERE id=$2`, [hash, id]);
    } else if (hasPasswordHash) {
      await pool.query(`UPDATE users SET password_hash=$1 WHERE id=$2`, [hash, id]);
    } else {
      return res.status(400).json({ error: 'PASSWORD_COLUMN_MISSING' });
    }

    await audit(req, 'users.reset_password', id, null);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

/* ============================
   VERIFICATION
============================ */
router.get('/verification/settings', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const r = await pool.query(`SELECT enabled FROM verification_settings WHERE id=1`);
    res.json({ enabled: r.rows[0]?.enabled ?? false });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

router.put('/verification/settings', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const enabled = typeof req.body?.enabled === 'boolean' ? req.body.enabled : toBool(req.body?.enabled);
    await pool.query(`UPDATE verification_settings SET enabled=$1, updated_at=NOW() WHERE id=1`, [enabled]);
    await audit(req, 'verification.settings', 'verification_settings:1', { enabled });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

router.get('/verification/requests', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const status = String(req.query.status || '').trim();
    const limit = Math.min(toInt(req.query.limit, 20), 200);

    const params = [];
    let where = '1=1';
    let i = 1;
    if (status) { where += ` AND status=$${i}`; params.push(status); i++; }

    const r = await pool.query(
      `SELECT id, user_id as "userId", status, docs_url as "docsUrl", created_at as "createdAt"
       FROM verification_requests
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT ${limit}`,
      params
    );

    res.json({ items: r.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

router.patch('/verification/requests/:id', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const id = req.params.id;
    const status = String(req.body?.status || '').trim();
    if (!status) return res.status(400).json({ error: 'VALIDATION_ERROR' });

    await pool.query(`UPDATE verification_requests SET status=$1 WHERE id=$2`, [status, id]);

    await audit(req, 'verification.request.status', id, { status });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

/* ============================
   NOTIFICATIONS + TEMPLATES
============================ */
router.post('/notifications/send', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const b = req.body || {};

    const target = String(b.target || 'all');
    const userId = b.userId ? String(b.userId).trim() : null;
    const title = String(b.title || '').trim();
    const body = String(b.body || '').trim();

    if (!title || !body) return res.status(400).json({ error: 'VALIDATION_ERROR' });

    if (target === 'user') {
      if (!userId) return res.status(400).json({ error: 'VALIDATION_ERROR' });
      await pool.query(
        `INSERT INTO notifications(id,user_id,title,body,read,created_at)
         VALUES($1,$2,$3,$4,false,NOW())`,
        [crypto.randomUUID(), userId, title, body]
      );
    } else {
      const users = await pool.query(`SELECT id FROM users`);
      for (const u of users.rows) {
        await pool.query(
          `INSERT INTO notifications(id,user_id,title,body,read,created_at)
           VALUES($1,$2,$3,$4,false,NOW())`,
          [crypto.randomUUID(), u.id, title, body]
        );
      }
    }

    await audit(req, 'notifications.send', null, { target, userId, title });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

router.get('/notifications/templates', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const r = await pool.query(`SELECT key, title, body, json, updated_at FROM notification_templates ORDER BY key ASC`);
    res.json({ items: r.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

router.put('/notifications/templates/:key', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const key = String(req.params.key || '').trim();
    if (!key) return res.status(400).json({ error: 'VALIDATION_ERROR' });

    const json = req.body && typeof req.body === 'object' ? req.body : {};
    const title = String(json.title || '').trim() || null;
    const body = String(json.body || '').trim() || null;

    await pool.query(
      `INSERT INTO notification_templates(key,title,body,json,updated_at)
       VALUES($1,$2,$3,$4,NOW())
       ON CONFLICT (key) DO UPDATE SET
         title=EXCLUDED.title,
         body=EXCLUDED.body,
         json=EXCLUDED.json,
         updated_at=NOW()`,
      [key, title, body, JSON.stringify(json)]
    );

    await audit(req, 'notifications.template.upsert', key, { title });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

router.delete('/notifications/templates/:key', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const key = String(req.params.key || '').trim();
    await pool.query(`DELETE FROM notification_templates WHERE key=$1`, [key]);
    await audit(req, 'notifications.template.delete', key, null);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

/* ============================
   REPORTS
============================ */
router.get('/reports', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const status = String(req.query.status || '').trim();
    const limit = Math.min(toInt(req.query.limit, 20), 200);

    const params = [];
    let where = '1=1';
    let i = 1;
    if (status) { where += ` AND status=$${i}`; params.push(status); i++; }

    const r = await pool.query(
      `SELECT id, ad_id as "adId", reason, status, created_at as "createdAt"
       FROM reports
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT ${limit}`,
      params
    );

    res.json({ items: r.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

router.patch('/reports/:id', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const id = req.params.id;
    const status = String(req.body?.status || '').trim();
    if (!status) return res.status(400).json({ error: 'VALIDATION_ERROR' });

    await pool.query(`UPDATE reports SET status=$1 WHERE id=$2`, [status, id]);

    await audit(req, 'reports.status', id, { status });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

/* ============================
   SUPPORT (settings + faq)
============================ */
router.get('/support/settings', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const r = await pool.query(`SELECT support_whatsapp, support_email, support_telegram FROM settings WHERE id=1`);
    const s = r.rows[0] || {};
    res.json({ whatsapp: s.support_whatsapp || '', email: s.support_email || '', telegram: s.support_telegram || '' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

router.put('/support/settings', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const b = req.body || {};

    await pool.query(
      `UPDATE settings SET
        support_whatsapp = COALESCE($1, support_whatsapp),
        support_email = COALESCE($2, support_email),
        support_telegram = COALESCE($3, support_telegram),
        updated_at = NOW()
       WHERE id=1`,
      [(b.whatsapp ?? null) || null, (b.email ?? null) || null, (b.telegram ?? null) || null]
    );

    await audit(req, 'support.settings', 'settings:1', b);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

router.get('/support/faq', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const r = await pool.query(`SELECT id, question, answer, active, ord FROM support_faq ORDER BY ord ASC, created_at DESC`);
    res.json({ items: r.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

router.post('/support/faq', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const b = req.body || {};
    const question = String(b.question || '').trim();
    const answer = String(b.answer || '').trim();
    if (!question || !answer) return res.status(400).json({ error: 'VALIDATION_ERROR' });

    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO support_faq(id, question, answer, active, ord, created_at, updated_at)
       VALUES($1,$2,$3,$4,$5,NOW(),NOW())`,
      [id, question, answer, toBool(b.active), toInt(b.order, 0)]
    );

    await audit(req, 'support.faq.create', id, { question });
    res.json({ ok: true, id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

router.put('/support/faq/:id', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const id = req.params.id;
    const b = req.body || {};

    await pool.query(
      `UPDATE support_faq SET
        question = COALESCE($2, question),
        answer = COALESCE($3, answer),
        active = COALESCE($4, active),
        ord = COALESCE($5, ord),
        updated_at = NOW()
       WHERE id=$1`,
      [
        id,
        b.question !== undefined ? String(b.question) : null,
        b.answer !== undefined ? String(b.answer) : null,
        b.active !== undefined ? toBool(b.active) : null,
        b.order !== undefined ? toInt(b.order, 0) : null
      ]
    );

    await audit(req, 'support.faq.update', id, null);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

router.delete('/support/faq/:id', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const id = req.params.id;
    await pool.query(`DELETE FROM support_faq WHERE id=$1`, [id]);
    await audit(req, 'support.faq.delete', id, null);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

/* ============================
   PREMIUM (plans + orders)
============================ */
router.get('/premium/plans', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const r = await pool.query(`SELECT key, price, days, benefits, active FROM premium_plans ORDER BY key ASC`);
    res.json({ items: r.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

router.post('/premium/plans', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const b = req.body || {};
    const key = String(b.key || '').trim();
    if (!key) return res.status(400).json({ error: 'VALIDATION_ERROR' });

    await pool.query(
      `INSERT INTO premium_plans(key, price, days, benefits, active, updated_at)
       VALUES($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (key) DO UPDATE SET
         price=EXCLUDED.price, days=EXCLUDED.days, benefits=EXCLUDED.benefits, active=EXCLUDED.active, updated_at=NOW()`,
      [key, toInt(b.price, 0), toInt(b.days, 0), String(b.benefits || ''), toBool(b.active)]
    );

    await audit(req, 'premium.plan.upsert', key, b);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

router.put('/premium/plans/:key', requireAdmin, async (req, res) => {
  req.body = { ...(req.body || {}), key: req.params.key };
  // نعاود نستعمل نفس منطق POST
  return router.handle({ ...req, method: 'POST', url: '/premium/plans' }, res);
});

router.delete('/premium/plans/:key', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const key = String(req.params.key || '').trim();
    await pool.query(`DELETE FROM premium_plans WHERE key=$1`, [key]);
    await audit(req, 'premium.plan.delete', key, null);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

router.get('/premium/orders', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const status = String(req.query.status || '').trim();
    const limit = Math.min(toInt(req.query.limit, 20), 200);

    const params = [];
    let where = '1=1';
    let i = 1;
    if (status) { where += ` AND status=$${i}`; params.push(status); i++; }

    const r = await pool.query(
      `SELECT id, user_id as "userId", ad_id as "adId", plan, status, created_at as "createdAt"
       FROM premium_orders
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT ${limit}`,
      params
    );

    res.json({ items: r.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

router.patch('/premium/orders/:id', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const id = req.params.id;
    const status = String(req.body?.status || '').trim();
    if (!status) return res.status(400).json({ error: 'VALIDATION_ERROR' });

    await pool.query(`UPDATE premium_orders SET status=$1 WHERE id=$2`, [status, id]);

    await audit(req, 'premium.order.status', id, { status });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

/* ============================
   MEDIA LIBRARY
============================ */
router.get('/media', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);

    const type = String(req.query.type || '').trim();     // image/video
    const unused = String(req.query.unused || '').trim(); // true/false
    const limit = Math.min(toInt(req.query.limit, 30), 200);

    const files = fs.existsSync(UPLOADS_DIR) ? fs.readdirSync(UPLOADS_DIR) : [];
    const raw = files.slice(0, 5000).map(f => {
      const p = path.join(UPLOADS_DIR, f);
      const st = fs.statSync(p);
      return { path: '/uploads/' + f, size: st.size };
    });

    const usedSet = new Set();

    // ads.video (عندك column video)
    if (await hasColumn(pool, 'ads', 'video').catch(() => false)) {
      await pool.query(`SELECT video FROM ads WHERE video IS NOT NULL`).then(r => r.rows.forEach(x => usedSet.add(x.video))).catch(() => {});
    }

    // ads.images (عندك column images) - ممكن يكون json/text => كنقلبو غير على /uploads/
    if (await hasColumn(pool, 'ads', 'images').catch(() => false)) {
      await pool.query(`SELECT images FROM ads WHERE images IS NOT NULL`).then(r => {
        r.rows.forEach(x => {
          const t = JSON.stringify(x.images || '');
          raw.forEach(f => { if (t.includes(f.path)) usedSet.add(f.path); });
        });
      }).catch(() => {});
    }

    // slides
    await pool.query(`SELECT image_url FROM home_slides`).then(r => r.rows.forEach(x => usedSet.add(x.image_url))).catch(() => {});
    // settings logo
    await pool.query(`SELECT logo_url FROM settings WHERE id=1`).then(r => { if (r.rows[0]?.logo_url) usedSet.add(r.rows[0].logo_url); }).catch(() => {});

    let out = raw.map(x => ({ path: x.path, size: x.size, used: usedSet.has(x.path) }));

    if (type === 'image') out = out.filter(x => ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(path.extname(x.path).toLowerCase()));
    if (type === 'video') out = out.filter(x => ['.mp4', '.webm', '.mov', '.mkv'].includes(path.extname(x.path).toLowerCase()));

    if (unused === 'true') out = out.filter(x => !x.used);
    if (unused === 'false') out = out.filter(x => x.used);

    out = out.slice(0, limit);
    res.json({ items: out });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

router.delete('/media', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const rel = String(req.body?.path || '').trim();
    if (!rel.startsWith('/uploads/')) return res.status(400).json({ error: 'VALIDATION_ERROR' });

    const filename = rel.replace('/uploads/', '');
    const p = path.join(UPLOADS_DIR, filename);
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'NOT_FOUND' });

    fs.unlinkSync(p);

    await audit(req, 'media.delete', rel, null);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

/* ============================
   SECURITY - Revoke Sessions
============================ */
router.post('/security/revoke-sessions', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const userId = String(req.body?.userId || '').trim();
    if (!userId) return res.status(400).json({ error: 'VALIDATION_ERROR' });

    await pool.query(
      `DELETE FROM session
       WHERE (sess->'user'->>'id') = $1`,
      [userId]
    ).catch(async () => {
      await pool.query(`DELETE FROM session WHERE sess::text ILIKE $1`, [`%"id":"${userId}"%`]).catch(() => {});
    });

    await audit(req, 'security.revoke_sessions', userId, null);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

module.exports = router;