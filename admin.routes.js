// admin.routes.js  (Samsar Admin API - Postgres)
// Use:
// const adminRoutes = require('./admin.routes');
// app.use('/api/admin', adminRoutes);

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

// Important: allow JSON or multipart on same endpoint
function maybeUploadSingle(field) {
  const mw = upload.single(field);
  return (req, res, next) => {
    const ct = String(req.headers['content-type'] || '');
    if (ct.includes('multipart/form-data')) return mw(req, res, next);
    return next();
  };
}

/* ============================
   SCHEMA ENSURE (non-destructive)
============================ */
let schemaReady = false;

async function ensureSchema(req) {
  if (schemaReady) return;
  const pool = getPool(req);
  if (!pool) throw new Error('POOL_MISSING');

  // audit
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

  // settings
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

  // home banner
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

  // quick categories
  await pool.query(`
    CREATE TABLE IF NOT EXISTS home_quick_categories(
      id INT PRIMARY KEY DEFAULT 1,
      keys TEXT[] NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`INSERT INTO home_quick_categories(id) VALUES (1) ON CONFLICT (id) DO NOTHING;`);

  // home slides
  await pool.query(`
    CREATE TABLE IF NOT EXISTS home_slides(
      id UUID PRIMARY KEY,
      image_url TEXT NOT NULL,
      link_url TEXT,
      ord INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // verification
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

  // notifications
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

router.post('/notifications/send', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const b = req.body || {};

    const target = String(b.target || 'all').trim(); // "all" | "user"
    const userId = b.userId ? String(b.userId).trim() : null;
    const title = String(b.title || '').trim();
    const body = String(b.body || '').trim();

    if (!title || !body) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'title/body required' });
    }

    // ✅ إرسال لمستخدم واحد
    if (target === 'user') {
      if (!userId) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'userId required' });

      await pool.query(
        `INSERT INTO notifications(user_id,title,body,read,created_at)
         VALUES($1,$2,$3,false,NOW())`,
        [userId, title, body]
      );

      await audit(req, 'notifications.send', userId, { target, title });
      return res.json({ ok: true, inserted: 1 });
    }

    // ✅ إرسال للجميع (مرة وحدة بلا loop)
    const r = await pool.query(
      `INSERT INTO notifications(user_id,title,body,read,created_at)
       SELECT u.id::text, $1, $2, false, NOW()
       FROM users u`,
      [title, body]
    );

    await audit(req, 'notifications.send', null, { target: 'all', title });

    // r.rowCount كيعطيك عدد rows اللي تزاد
    res.json({ ok: true, inserted: r.rowCount || 0 });

  } catch (e) {
    console.error('NOTIF_SEND_ERROR:', e);
    // ✅ رجّع message باش تعرف الخطأ الحقيقي فـ Network
    res.status(500).json({ error: 'SERVER_ERROR', message: String(e.message || e) });
  }
});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notification_templates(
      key TEXT PRIMARY KEY,
      title TEXT,
      body TEXT,
      json JSONB,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // reports
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

// ✅ PUT بدون :id (باش يوافق Admin UI اللي كيدير PUT /api/admin/support/faq)
router.put('/support/faq', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);

    const id = String(req.body?.id || '').trim();
    if (!id) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'id required' });

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

// ✅ DELETE بدون :id (باش يوافق Admin UI اللي كيدير DELETE /api/admin/support/faq)
router.delete('/support/faq', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);

    const id = String(req.body?.id || '').trim();
    if (!id) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'id required' });

    await pool.query(`DELETE FROM support_faq WHERE id=$1`, [id]);

    await audit(req, 'support.faq.delete', id, null);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

  // support faq
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

  // premium
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

  // Ensure ads.user_id exists (needed by server.js)
  const adsExists = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name='ads' LIMIT 1`
  ).then(r => !!r.rows[0]).catch(() => false);

  if (adsExists) {
    await pool.query(`ALTER TABLE ads ADD COLUMN IF NOT EXISTS user_id TEXT`).catch(() => {});
    await pool.query(`ALTER TABLE ads ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`).catch(() => {});

    // ✅ مهمين باش featured/status يخدمو فالأدمن والسيرفر
    await pool.query(`ALTER TABLE ads ADD COLUMN IF NOT EXISTS featured BOOLEAN DEFAULT false`).catch(() => {});
    await pool.query(`ALTER TABLE ads ADD COLUMN IF NOT EXISTS status TEXT`).catch(() => {});
    await pool.query(`UPDATE ads SET status='published' WHERE status IS NULL`).catch(() => {});
  }
  
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
   CATEGORIES (FIXED) ✅
   - Admin UI sends: { id:"phones", name, description, image, order, active }
   - We store UI id into categories.key (TEXT UNIQUE)
   - DB categories.id could be INTEGER (serial) OR UUID => we auto-detect
============================ */
async function ensureCategoriesShape(pool) {
  const exists = await hasTable(pool, 'categories').catch(() => false);
  if (!exists) throw new Error('CATEGORIES_TABLE_MISSING');

  const addCol = async (col, sql) => {
    const ok = await hasColumn(pool, 'categories', col).catch(() => false);
    if (!ok) await pool.query(sql);
  };

  await addCol('key', `ALTER TABLE categories ADD COLUMN key TEXT UNIQUE`);
  await addCol('description', `ALTER TABLE categories ADD COLUMN description TEXT`);
  await addCol('image_url', `ALTER TABLE categories ADD COLUMN image_url TEXT`);
  await addCol('ord', `ALTER TABLE categories ADD COLUMN ord INT DEFAULT 0`);
  await addCol('active', `ALTER TABLE categories ADD COLUMN active BOOLEAN DEFAULT true`);
  await addCol('created_at', `ALTER TABLE categories ADD COLUMN created_at TIMESTAMPTZ DEFAULT NOW()`);
  await addCol('updated_at', `ALTER TABLE categories ADD COLUMN updated_at TIMESTAMPTZ DEFAULT NOW()`);
}

async function getCategoriesIdType(pool) {
  const r = await pool.query(
    `SELECT data_type, udt_name
     FROM information_schema.columns
     WHERE table_name='categories' AND column_name='id'
     LIMIT 1`
  );
  const row = r.rows[0] || {};
  // udt_name for uuid is usually "uuid"
  const isUuid = String(row.udt_name || '').toLowerCase() === 'uuid';
  // integers: integer, int4, int8, bigint, serial...
  const isIntLike =
    ['integer', 'bigint'].includes(String(row.data_type || '').toLowerCase()) ||
    ['int4', 'int8'].includes(String(row.udt_name || '').toLowerCase());

  return { isUuid, isIntLike, raw: row };
}

router.get('/categories', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    await ensureCategoriesShape(pool);

    const r = await pool.query(`
      SELECT id, key, name, description, image_url, ord, active, created_at
      FROM categories
      ORDER BY ord ASC, created_at DESC
    `);

    res.json({
      items: r.rows.map(c => ({
        // admin UI uses "id" as the category key string
        id: c.key || String(c.id),
        dbId: c.id,
        key: c.key || '',
        name: c.name || '',
        description: c.description || '',
        image: c.image_url || '',
        order: c.ord ?? 0,
        active: c.active !== false
      }))
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR', message: String(e.message || e) });
  }
});

router.post('/categories', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    await ensureCategoriesShape(pool);

    const b = req.body || {};
    const key = String(b.id || b.key || '').trim(); // Category ID (key) from admin UI
    const name = String(b.name || '').trim();
    const description = String(b.description || '');
    const image = String(b.image || '') || null;
    const ord = toInt(b.order, 0);
    const active = (b.active === undefined) ? true : toBool(b.active);

    if (!key || !name) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'id(key) + name required' });
    }

    // key must be unique
    const ex = await pool.query(`SELECT 1 FROM categories WHERE key=$1 LIMIT 1`, [key]);
    if (ex.rows[0]) return res.status(409).json({ error: 'ALREADY_EXISTS' });

    const { isUuid, isIntLike } = await getCategoriesIdType(pool);

    let dbId = null;

    if (isUuid) {
      // categories.id is UUID
      dbId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO categories(id, key, name, description, image_url, ord, active, created_at, updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())
         RETURNING id`,
        [dbId, key, name, description, image, ord, active]
      );
    } else if (isIntLike) {
      // categories.id is INTEGER/SERIAL => DO NOT pass id, let DB generate it
      const ins = await pool.query(
        `INSERT INTO categories(key, name, description, image_url, ord, active, created_at, updated_at)
         VALUES($1,$2,$3,$4,$5,$6,NOW(),NOW())
         RETURNING id`,
        [key, name, description, image, ord, active]
      );
      dbId = ins.rows[0]?.id ?? null;
    } else {
      // fallback: try insert without id (most compatible)
      const ins = await pool.query(
        `INSERT INTO categories(key, name, description, image_url, ord, active, created_at, updated_at)
         VALUES($1,$2,$3,$4,$5,$6,NOW(),NOW())
         RETURNING id`,
        [key, name, description, image, ord, active]
      );
      dbId = ins.rows[0]?.id ?? null;
    }

    await audit(req, 'categories.create', String(dbId ?? key), { key, name });
    res.json({ ok: true, id: key, dbId });
  } catch (e) {
    console.error(e);
    // duplicate key or duplicate unique index
    if (String(e.message || '').toLowerCase().includes('duplicate')) {
      return res.status(409).json({ error: 'ALREADY_EXISTS' });
    }
    res.status(500).json({ error: 'SERVER_ERROR', message: String(e.message || e) });
  }
});

router.put('/categories/:id', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    await ensureCategoriesShape(pool);

    const keyOrId = String(req.params.id || '').trim();
    const b = req.body || {};

    // find row by key OR id (works for uuid/int)
    const row = await pool.query(
      `SELECT id FROM categories WHERE key=$1 OR id::text=$1 LIMIT 1`,
      [keyOrId]
    );
    const dbId = row.rows[0]?.id;
    if (!dbId) return res.status(404).json({ error: 'NOT_FOUND' });

    const sets = [];
    const params = [dbId];
    let i = 2;

    if (b.name !== undefined) { sets.push(`name=$${i++}`); params.push(String(b.name).trim()); }
    if (b.description !== undefined) { sets.push(`description=$${i++}`); params.push(String(b.description)); }
    if (b.image !== undefined) { sets.push(`image_url=$${i++}`); params.push(String(b.image) || null); }
    if (b.order !== undefined) { sets.push(`ord=$${i++}`); params.push(toInt(b.order, 0)); }
    if (b.active !== undefined) { sets.push(`active=$${i++}`); params.push(toBool(b.active)); }

    sets.push(`updated_at=NOW()`);

    await pool.query(`UPDATE categories SET ${sets.join(', ')} WHERE id=$1`, params);

    await audit(req, 'categories.update', String(dbId), { keyOrId });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR', message: String(e.message || e) });
  }
});

router.delete('/categories/:id', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    await ensureCategoriesShape(pool);

    const keyOrId = String(req.params.id || '').trim();
    const row = await pool.query(
      `SELECT id FROM categories WHERE key=$1 OR id::text=$1 LIMIT 1`,
      [keyOrId]
    );
    const dbId = row.rows[0]?.id;
    if (!dbId) return res.json({ ok: true });

    await pool.query(`DELETE FROM categories WHERE id=$1`, [dbId]);

    await audit(req, 'categories.delete', String(dbId), { keyOrId });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR', message: String(e.message || e) });
  }
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
   HOME - banner / sections / quick-categories
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
   ADS (Admin) - aligns with server.js schema
   ads: user_id (uuid/text), category_id (uuid), city, featured, status...
============================ */
router.get('/ads', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);

    const qTxt = String(req.query.q || '').trim();
    const status = String(req.query.status || '').trim();
    const category = String(req.query.category || '').trim(); // category_id
    const city = String(req.query.city || '').trim();
    const featured = String(req.query.featured || '').trim();
    const limit = Math.min(toInt(req.query.limit, 20), 100);

    const where = [];
    const params = [];
    let i = 1;

    const hasDesc = await hasColumn(pool, 'ads', 'description').catch(() => false);
    const hasStatus = await hasColumn(pool, 'ads', 'status').catch(() => false);
    const hasFeatured = await hasColumn(pool, 'ads', 'featured').catch(() => false);
    const hasCity = await hasColumn(pool, 'ads', 'city').catch(() => false);
    const hasCategoryId = await hasColumn(pool, 'ads', 'category_id').catch(() => false);
    const hasUserId = await hasColumn(pool, 'ads', 'user_id').catch(() => false);

    if (qTxt) {
      const parts = [`a.title ILIKE $${i}`];
      if (hasDesc) parts.push(`a.description ILIKE $${i}`);
      where.push(`(${parts.join(' OR ')})`);
      params.push(`%${qTxt}%`);
      i++;
    }

    if (status && hasStatus) { where.push(`a.status = $${i}`); params.push(status); i++; }
    if (category && hasCategoryId) { where.push(`a.category_id::text = $${i}`); params.push(category); i++; }
    if (city && hasCity) { where.push(`a.city ILIKE $${i}`); params.push(city); i++; }

    if (hasFeatured) {
      if (featured === 'true') where.push(`a.featured = true`);
      if (featured === 'false') where.push(`a.featured = false`);
    }

    const r = await pool.query(
      `SELECT
         a.id,
         a.title,
         ${hasStatus ? 'a.status' : `'published' as status`},
         ${hasFeatured ? 'a.featured' : 'false as featured'},
         ${hasUserId ? `a.user_id::text as "ownerId"` : `NULL as "ownerId"`}
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

    await pool.query(`UPDATE ads SET status=$1 WHERE id::text=$2`, [status, String(id)]);
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

    await pool.query(`UPDATE ads SET featured=$1 WHERE id::text=$2`, [featured, String(id)]);
    await audit(req, 'ads.feature', id, { featured });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

router.patch('/ads/:id/owner', requireAdmin, async (req, res) => {
  try {
    await ensureSchema(req);
    const pool = getPool(req);
    const adId = req.params.id;
    const newUserId = String(req.body?.newUserId || '').trim();
    if (!newUserId) return res.status(400).json({ error: 'VALIDATION_ERROR' });

    if (!(await hasColumn(pool, 'ads', 'user_id').catch(() => false))) {
      return res.status(400).json({ error: 'USER_ID_COLUMN_MISSING' });
    }

    const u = await pool.query(`SELECT id FROM users WHERE id=$1`, [newUserId]);
    if (!u.rows[0]) return res.status(404).json({ error: 'USER_NOT_FOUND' });

    await pool.query(`UPDATE ads SET user_id=$1 WHERE id=$2`, [newUserId, adId]);

    await audit(req, 'ads.owner', adId, { newUserId });
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

    await pool.query(`DELETE FROM ads WHERE id::text=$1`, [String(id)]);

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

    const qTxt = String(req.query.q || '').trim();
    const role = String(req.query.role || '').trim();        // user/admin
    const status = String(req.query.status || '').trim();    // active/banned/disabled
    const verified = String(req.query.verified || '').trim();// true/false
    const limit = Math.min(toInt(req.query.limit, 20), 200);

    const where = [];
    const params = [];
    let i = 1;

    const hasPhone = await hasColumn(pool, 'users', 'phone').catch(() => false);
    const hasVerified = await hasColumn(pool, 'users', 'verified').catch(() => false);
    const hasDisabled = await hasColumn(pool, 'users', 'disabled').catch(() => false);
    const hasIsAdmin = await hasColumn(pool, 'users', 'is_admin').catch(() => false);

    if (qTxt) {
      const parts = [`u.name ILIKE $${i}`, `u.email ILIKE $${i}`];
      if (hasPhone) parts.push(`u.phone ILIKE $${i}`);
      where.push(`(${parts.join(' OR ')})`);
      params.push(`%${qTxt}%`);
      i++;
    }

    if (hasIsAdmin) {
      if (role === 'admin') where.push(`u.is_admin = true`);
      if (role === 'user') where.push(`u.is_admin = false`);
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
      if (role === 'user') isAdmin = false;
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

    const target = String(b.target || 'all').trim(); // "all" | "user"
    const userId = b.userId ? String(b.userId).trim() : null;
    const title = String(b.title || '').trim();
    const body = String(b.body || '').trim();

    if (!title || !body) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'title/body required' });
    }

    // ✅ إرسال لمستخدم واحد
    if (target === 'user') {
      if (!userId) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'userId required' });

      await pool.query(
        `INSERT INTO notifications(user_id,title,body,read,created_at)
         VALUES($1,$2,$3,false,NOW())`,
        [userId, title, body]
      );

      await audit(req, 'notifications.send', userId, { target, title });
      return res.json({ ok: true, inserted: 1 });
    }

    // ✅ إرسال للجميع (مرة وحدة بلا loop)
    const r = await pool.query(
      `INSERT INTO notifications(user_id,title,body,read,created_at)
       SELECT u.id::text, $1, $2, false, NOW()
       FROM users u`,
      [title, body]
    );

    await audit(req, 'notifications.send', null, { target: 'all', title });

    // r.rowCount كيعطيك عدد rows اللي تزاد
    res.json({ ok: true, inserted: r.rowCount || 0 });

  } catch (e) {
    console.error('NOTIF_SEND_ERROR:', e);
    // ✅ رجّع message باش تعرف الخطأ الحقيقي فـ Network
    res.status(500).json({ error: 'SERVER_ERROR', message: String(e.message || e) });
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

    const r = await pool.query(`
      SELECT
        id,
        question,
        answer,
        active,
        ord AS "order"
      FROM support_faq
      ORDER BY ord ASC, created_at DESC
    `);

    res.json({
      items: r.rows.map(x => ({
        id: x.id,
        question: x.question || '',
        answer: x.answer || '',
        active: x.active !== false,
        order: Number.isFinite(+x.order) ? +x.order : 0
      }))
    });
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

    if (await hasColumn(pool, 'ads', 'video_url').catch(() => false)) {
      await pool.query(`SELECT video_url FROM ads WHERE video_url IS NOT NULL`)
        .then(r => r.rows.forEach(x => usedSet.add(x.video_url))).catch(() => {});
    }

    // home slides
    await pool.query(`SELECT image_url FROM home_slides`)
      .then(r => r.rows.forEach(x => usedSet.add(x.image_url))).catch(() => {});
    // settings logo
    await pool.query(`SELECT logo_url FROM settings WHERE id=1`)
      .then(r => { if (r.rows[0]?.logo_url) usedSet.add(r.rows[0].logo_url); }).catch(() => {});

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