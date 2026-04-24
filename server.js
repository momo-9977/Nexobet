// server.js (Samsar - Node.js + Express + Postgres)
// -------------------------------------------------
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const cors = require('cors');
const bcrypt = require('bcrypt');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const multer = require('multer');
const { z } = require('zod');
const crypto = require('crypto');

const { pool, q } = require('./db');
const adminRoutes = require('./admin.routes');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

/* -------------------- Directories -------------------- */

const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

/* -------------------- Middlewares -------------------- */

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('dev'));

const BASE_URL = (process.env.BASE_URL || '').trim();

// CORS: فـ prod نخلي غير BASE_URL إلا كان معروف، إلا ماكانش نخلي request يمر (باش ماطيحش)
// مهم: إذا كنت خدام بنفس الدومين ديال السيرفر، راه OK.
app.use(cors({
  origin: (origin, cb) => {
    if (!IS_PROD) return cb(null, true);
    if (!origin) return cb(null, true); // same-origin / server-to-server
    if (!BASE_URL) return cb(null, true);
    if (origin === BASE_URL) return cb(null, true);
    return cb(null, false);
  },
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

/* -------------------- Sessions -------------------- */

// ماطيحش السيرفر إذا SESSION_SECRET ناقص: نديرو fallback (ولكن الأفضل تحطو فـ Railway)
let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET || !SESSION_SECRET.trim()) {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('⚠️ SESSION_SECRET is missing. Using a random secret (sessions reset on restart). Set SESSION_SECRET in Railway Vars.');
}

app.use(session({
  store: new pgSession({
    pool,
    tableName: 'session',
    createTableIfMissing: true
  }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: IS_PROD,     // فـ Railway prod => true
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 14
  }
}));

// مهم ل admin.routes
app.set('pool', pool);

/* -------------------- Static -------------------- */

app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(PUBLIC_DIR));

/* -------------------- Helpers: DB/Schema -------------------- */

async function ensureCoreSettings() {
  await q(`
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
  await q(`INSERT INTO settings(id) VALUES (1) ON CONFLICT (id) DO NOTHING;`);
}

async function getSettings() {
  await ensureCoreSettings();
  const r = await q('SELECT * FROM settings WHERE id=1');
  return r.rows[0] || null;
}

async function hasColumn(table, column) {
  try {
    const r = await q(
      `SELECT 1
       FROM information_schema.columns
       WHERE table_name=$1 AND column_name=$2
       LIMIT 1`,
      [table, column]
    );
    return !!r.rows[0];
  } catch {
    return false;
  }
}

async function hasTable(table) {
  try {
    const r = await q(
      `SELECT 1 FROM information_schema.tables WHERE table_name=$1 LIMIT 1`,
      [table]
    );
    return !!r.rows[0];
  } catch {
    return false;
  }
}

function toInt(v, d = 0) {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : d;
}

function safeFilenameUrl(file) {
  if (!file) return null;
  return '/uploads/' + file.filename;
}

/* -------------------- Auto-fix DB Shape (safe) -------------------- */

let schemaReady = false;
let adsIdType = null; // 'uuid' | 'other'

async function ensureDbShape() {
  if (schemaReady) return;

  // pgcrypto (for gen_random_uuid)
  await q(`CREATE EXTENSION IF NOT EXISTS pgcrypto`).catch(() => {});

  // categories extras
  if (await hasTable('categories')) {
    await q(`ALTER TABLE categories ADD COLUMN IF NOT EXISTS key TEXT`).catch(() => {});
    await q(`ALTER TABLE categories ADD COLUMN IF NOT EXISTS description TEXT`).catch(() => {});
    await q(`ALTER TABLE categories ADD COLUMN IF NOT EXISTS image_url TEXT`).catch(() => {});
    await q(`ALTER TABLE categories ADD COLUMN IF NOT EXISTS ord INT DEFAULT 0`).catch(() => {});
    await q(`ALTER TABLE categories ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true`).catch(() => {});
    await q(`ALTER TABLE categories ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`).catch(() => {});
    await q(`ALTER TABLE categories ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`).catch(() => {});
  }

  // ads columns
  if (await hasTable('ads')) {
    await q(`ALTER TABLE ads ADD COLUMN IF NOT EXISTS featured BOOLEAN DEFAULT false`).catch(() => {});
    await q(`ALTER TABLE ads ADD COLUMN IF NOT EXISTS user_id TEXT`).catch(() => {});
    await q(`ALTER TABLE ads ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`).catch(() => {});
    // صفّر أي NULL ديال featured
    await q(`UPDATE ads SET featured=false WHERE featured IS NULL`).catch(() => {});
  }

  // detect ads.id type + ensure default if uuid
  const idInfo = await q(`
    SELECT udt_name, column_default
    FROM information_schema.columns
    WHERE table_name='ads' AND column_name='id'
    LIMIT 1
  `).catch(() => ({ rows: [] }));

  const idRow = idInfo.rows[0];
  if (idRow && idRow.udt_name === 'uuid') {
    adsIdType = 'uuid';
    if (!idRow.column_default) {
      await q(`ALTER TABLE ads ALTER COLUMN id SET DEFAULT gen_random_uuid()`).catch(() => {});
    }
  } else {
    adsIdType = 'other';
  }

  // ad_images: نخلي ad_id TEXT باش مايبقاش mismatch مع uuid/int
  await q(`
    CREATE TABLE IF NOT EXISTS ad_images(
      id BIGSERIAL PRIMARY KEY,
      ad_id TEXT,
      url TEXT,
      ord INT DEFAULT 0
    );
  `).catch(() => {});

  schemaReady = true;
}

/* -------------------- Auth Helpers -------------------- */

function safeUserRow(u) {
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    city: u.city,
    bio: u.bio,
    avatar: u.avatar,
    disabled: !!u.disabled,
    is_admin: !!u.is_admin,
    createdAt: u.created_at
  };
}

async function loadUser(userId) {
  const r = await q(
    `SELECT id,name,email,phone,city,bio,avatar,disabled,is_admin,created_at
     FROM users WHERE id=$1`,
    [userId]
  );
  return r.rows[0] || null;
}

function requireAuthApi(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'UNAUTHORIZED' });
  next();
}

function requireAuthPage(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function requireAdminPage(req, res, next) {
  const u = req.session.user;
  if (!u) return res.redirect('/login');
  if (!u.is_admin) return res.redirect('/');
  next();
}

/* -------------------- category resolver -------------------- */

async function resolveCategoryId(input) {
  const v = String(input || '').trim();
  if (!v) return null;

  // UUID?
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
  if (isUuid) return v;

  // int?
  if (/^\d+$/.test(v)) return parseInt(v, 10);

  const hasKey = await hasColumn('categories', 'key');
  const r = await q(
    `SELECT id
     FROM categories
     WHERE ${hasKey ? 'key=$1 OR ' : ''} lower(name)=lower($1)
     LIMIT 1`,
    [v]
  );
  return r.rows[0]?.id ?? null;
}

/* -------------------- Upload -------------------- */

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const base = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, base + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 1024 * 2 } // 2GB hard limit
});

/* =========================================================
   Pages
   ========================================================= */

app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/categories', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'categories.html')));
app.get('/ad', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'ad.html')));
app.get('/support', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'support.html')));
app.get('/login', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'register.html')));

app.get('/post-ad', requireAuthPage, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'post-ad.html')));
app.get('/profile', requireAuthPage, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'profile.html')));
app.get('/edit-ad', requireAuthPage, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'edit-ad.html')));
app.get('/admin', requireAdminPage, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));

/* =========================================================
   PUBLIC API
   ========================================================= */

app.get('/api/settings', async (req, res) => {
  try {
    const s = await getSettings();
    if (!s) return res.json({});
    res.json({
      platformName: s.platform_name,
      subtitle: s.subtitle,
      logoUrl: s.logo_url,
      supportWhatsapp: s.support_whatsapp,
      supportEmail: s.support_email,
      supportTelegram: s.support_telegram,
      allowRegister: s.allow_register,
      uploads: {
        maxImages: s.max_images,
        maxImageMb: s.max_image_mb,
        maxVideoMb: s.max_video_mb
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    await ensureDbShape();

    const hasActive = await hasColumn('categories', 'active');
    const hasOrd = await hasColumn('categories', 'ord');
    const hasCreatedAt = await hasColumn('categories', 'created_at');

    const result = await q(`
      SELECT id, name
      FROM categories
      ${hasActive ? 'WHERE COALESCE(active,true)=true' : ''}
      ORDER BY
        ${hasOrd ? 'ord ASC,' : ''}
        ${hasCreatedAt ? 'created_at DESC' : 'id ASC'}
    `);

    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// ✅ واحد endpoint كافي: latest + featured + filters + image
app.get('/api/ads', async (req, res) => {
  try {
    await ensureDbShape();

    const { q: query, category, city, limit, featured } = req.query;

    const lim = Math.min(parseInt(limit || '20', 10), 50);
    const where = [`a.status='published'`];
    const params = [];
    let i = 1;

    if (featured === 'true' || featured === true || featured === '1') {
      where.push(`COALESCE(a.featured,false)=true`);
    }

    if (query) {
      where.push(`(a.title ILIKE $${i} OR a.description ILIKE $${i})`);
      params.push(`%${query}%`);
      i++;
    }

    if (category) {
      const hasCategoryId = await hasColumn('ads', 'category_id');
      if (hasCategoryId) {
        const catId = await resolveCategoryId(category);
        if (catId) {
          where.push(`a.category_id::text = $${i}`);
          params.push(String(catId));
          i++;
        }
      } else if (await hasColumn('ads', 'category')) {
        where.push(`a.category = $${i}`);
        params.push(String(category));
        i++;
      }
    }

    if (city) {
      where.push(`a.city ILIKE $${i}`);
      params.push(`%${city}%`);
      i++;
    }

    const r = await q(`
      SELECT
        a.*,
        (
          SELECT url
          FROM ad_images
          WHERE ad_id = a.id::text
          ORDER BY ord ASC
          LIMIT 1
        ) AS image
      FROM ads a
      WHERE ${where.join(' AND ')}
      ORDER BY a.created_at DESC
      LIMIT ${lim}
    `, params);

    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR', message: String(e.message || e) });
  }
});

// ✅ optional endpoint (باش ما نكسروش شي front قديم)
app.get('/api/ads/featured', async (req, res) => {
  req.query.featured = 'true';
  req.query.limit = req.query.limit || '10';
  return app._router.handle(req, res, () => {}, 'get', '/api/ads');
});

/* =========================================================
   AUTH API
   ========================================================= */

app.get('/api/auth/me', async (req, res) => {
  try {
    if (!req.session.user) return res.status(401).json({ error: 'UNAUTHORIZED' });
    const u = await loadUser(req.session.user.id);
    if (!u) return res.status(401).json({ error: 'UNAUTHORIZED' });
    res.json(safeUserRow(u));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const s = await getSettings();
    if (!s || s.allow_register !== true) return res.status(403).json({ error: 'REGISTER_DISABLED' });

    const schema = z.object({
      name: z.string().min(2),
      email: z.string().email(),
      password: z.string().min(6)
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR' });

    const { name, email, password } = parsed.data;

    const exists = await q('SELECT id FROM users WHERE lower(email)=lower($1)', [email.trim()]);
    if (exists.rows[0]) return res.status(409).json({ error: 'EMAIL_EXISTS' });

    const hash = await bcrypt.hash(password, 10);
    const id = crypto.randomUUID();

    await q(`
      INSERT INTO users (id,name,email,password,disabled,is_admin,created_at)
      VALUES ($1,$2,$3,$4,false,false,now())
    `, [id, name, email.toLowerCase(), hash]);

    req.session.user = { id, is_admin: false };

    const u = await loadUser(id);
    res.json(safeUserRow(u));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const schema = z.object({
      email: z.string().email(),
      password: z.string().min(1)
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR' });

    const { email, password } = parsed.data;

    const r = await q(
      `SELECT id,password,disabled,is_admin
       FROM users
       WHERE lower(email)=lower($1)
       LIMIT 1`,
      [email.trim()]
    );

    const u = r.rows[0];
    if (!u) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
    if (u.disabled) return res.status(403).json({ error: 'ACCOUNT_DISABLED' });

    const ok = await bcrypt.compare(password, u.password);
    if (!ok) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });

    req.session.user = { id: u.id, is_admin: !!u.is_admin };

    const full = await loadUser(u.id);
    res.json(safeUserRow(full));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

/* =========================================================
   ADS API (My ads + Create + Delete)
   ========================================================= */

app.get('/api/my/ads', requireAuthApi, async (req, res) => {
  try {
    await ensureDbShape();

    const userId = String(req.session.user.id);
    const hasUserId = await hasColumn('ads', 'user_id');
    if (!hasUserId) return res.json([]);

    const r = await q(`
      SELECT
        a.*,
        (
          SELECT url FROM ad_images
          WHERE ad_id = a.id::text
          ORDER BY ord ASC
          LIMIT 1
        ) AS image
      FROM ads a
      WHERE a.user_id=$1
      ORDER BY a.created_at DESC
    `, [userId]);

    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR', message: String(e.message || e) });
  }
});

app.post('/api/ads', requireAuthApi, upload.fields([
  { name: 'images', maxCount: 6 },
  { name: 'video', maxCount: 1 }
]), async (req, res) => {
  try {
    await ensureDbShape();

    const s = await getSettings();
    const maxImages = toInt(s?.max_images, 6);
    const maxImageMb = toInt(s?.max_image_mb, 10);
    const maxVideoMb = toInt(s?.max_video_mb, 1024);

    const schema = z.object({
      title: z.string().min(2),
      description: z.string().min(3),
      price: z.coerce.number().min(0),
      city: z.string().min(1),
      category: z.string().min(1)
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR', details: parsed.error.issues });

    const images = (req.files?.images || []).slice(0, maxImages);
    const videoFile = (req.files?.video && req.files.video[0]) ? req.files.video[0] : null;

    const maxImageBytes = maxImageMb * 1024 * 1024;
    for (const f of images) {
      if (f.size > maxImageBytes) return res.status(400).json({ error: 'IMAGE_TOO_LARGE' });
    }

    if (videoFile) {
      const maxVideoBytes = maxVideoMb * 1024 * 1024;
      if (videoFile.size > maxVideoBytes) return res.status(400).json({ error: 'VIDEO_TOO_LARGE' });
    }

    const userId = String(req.session.user.id);
    const { title, description, price, city, category } = parsed.data;

    const hasCategoryId = await hasColumn('ads', 'category_id');
    const hasCategory = await hasColumn('ads', 'category');
    const hasUserId = await hasColumn('ads', 'user_id');

    if (!hasUserId) return res.status(500).json({ error: 'ADS_USER_ID_MISSING' });

    let categoryId = null;
    if (hasCategoryId) {
      categoryId = await resolveCategoryId(category);
      if (!categoryId) return res.status(400).json({ error: 'CATEGORY_NOT_FOUND' });
    }

    const videoUrl = videoFile ? safeFilenameUrl(videoFile) : null;
    const hasVideoUrl = await hasColumn('ads', 'video_url');
    const hasVideo = await hasColumn('ads', 'video');
    const videoCol = hasVideoUrl ? 'video_url' : (hasVideo ? 'video' : null);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      let adRes;

      // ✅ مهم: featured ALWAYS false عند النشر (إلا من الادمن)
      if (hasCategoryId) {
        const cols = ['user_id','title','description','price','city','category_id','status','featured'];
        const vals = [userId, title, description, price, city, categoryId, 'published', false];
        if (videoCol) { cols.push(videoCol); vals.push(videoUrl); }

        const ph = cols.map((_, idx) => `$${idx + 1}`).join(',');
        adRes = await client.query(
          `INSERT INTO ads(${cols.join(',')}) VALUES(${ph}) RETURNING id`,
          vals
        );
      } else if (hasCategory) {
        const cols = ['user_id','title','description','price','city','category','status','featured'];
        const vals = [userId, title, description, price, city, String(category), 'published', false];
        if (videoCol) { cols.push(videoCol); vals.push(videoUrl); }

        const ph = cols.map((_, idx) => `$${idx + 1}`).join(',');
        adRes = await client.query(
          `INSERT INTO ads(${cols.join(',')}) VALUES(${ph}) RETURNING id`,
          vals
        );
      } else {
        await client.query('ROLLBACK');
        return res.status(500).json({ error: 'ADS_CATEGORY_COLUMN_MISSING' });
      }

      const adId = adRes.rows[0].id; // ✅ قبل loop ديال الصور

      for (let idx = 0; idx < images.length; idx++) {
        const url = safeFilenameUrl(images[idx]);
        await client.query(
          `INSERT INTO ad_images (ad_id,url,ord) VALUES ($1,$2,$3)`,
          [String(adId), url, idx]
        );
      }

      await client.query('COMMIT');
      res.json({ ok: true, ad: { id: adId } });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(e);
      res.status(500).json({ error: 'SERVER_ERROR', message: String(e.message || e) });
    } finally {
      client.release();
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR', message: String(e.message || e) });
  }
});

app.delete('/api/ads/:id', requireAuthApi, async (req, res) => {
  try {
    await ensureDbShape();

    const adId = String(req.params.id);
    const userId = String(req.session.user.id);

    const hasUserId = await hasColumn('ads', 'user_id');
    if (!hasUserId) return res.status(500).json({ error: 'ADS_USER_ID_MISSING' });

    const r = await q('SELECT id,user_id FROM ads WHERE id::text=$1', [adId]);
    if (!r.rows[0]) return res.status(404).json({ error: 'NOT_FOUND' });

    if (String(r.rows[0].user_id) !== userId) return res.status(403).json({ error: 'FORBIDDEN' });

    await q('DELETE FROM ad_images WHERE ad_id=$1', [adId]).catch(() => {});
    await q('DELETE FROM ads WHERE id::text=$1', [adId]);

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR', message: String(e.message || e) });
  }
});

/* =========================================================
   Health
   ========================================================= */

app.get('/api/health', async (req, res) => {
  try {
    await q('SELECT 1');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

/* =========================================================
   Admin Routes
   ========================================================= */

app.use('/api/admin', adminRoutes);

/* =========================================================
   Start
   ========================================================= */

async function start() {
  try {
    await ensureDbShape();
    await ensureCoreSettings();

    app.listen(PORT, () => {
      console.log(`✅ Samsar server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Startup failed:', err);
    process.exit(1);
  }
}

start();