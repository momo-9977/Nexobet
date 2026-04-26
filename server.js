// server.js  (Samsar - Node.js + Express + Postgres)
// ---------------------------------------------------
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

// ✅ uploads فـ volume (دائم) إذا كان /data موجود
const VOLUME_ROOT = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
const UPLOADS_DIR = fs.existsSync(VOLUME_ROOT)
  ? path.join(VOLUME_ROOT, 'uploads')
  : path.join(PUBLIC_DIR, 'uploads'); // fallback local

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ✅ Serve uploads
app.use('/uploads', express.static(UPLOADS_DIR, {
  maxAge: '7d',
  immutable: true
}));

// ✅ Serve public
app.use(express.static(PUBLIC_DIR));

/* -------------------- Middlewares -------------------- */

app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('dev'));

// CORS
const CORS_ORIGIN =
  IS_PROD
    ? (process.env.BASE_URL && process.env.BASE_URL.trim() ? process.env.BASE_URL.trim() : true)
    : true;

app.use(cors({
  origin: CORS_ORIGIN,
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Railway/Proxy
app.set('trust proxy', 1);

/* -------------------- Sessions (NO CRASH) -------------------- */
// مهم: باش مايبقاش كيطير login، خاص SESSION_SECRET يكون ثابت فـ Railway Variables
const SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.trim()
    ? process.env.SESSION_SECRET.trim()
    : crypto.randomBytes(32).toString('hex');

if (IS_PROD && !(process.env.SESSION_SECRET && process.env.SESSION_SECRET.trim())) {
  console.warn('⚠️ SESSION_SECRET missing in production. Using random secret (sessions reset on restart).');
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
    secure: IS_PROD,
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

/* -------------------- Auto-fix DB Shape (safe) -------------------- */

let schemaReady = false;

async function ensureDbShape() {
  if (schemaReady) return;

  // settings
  await ensureCoreSettings();

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
    await q(`ALTER TABLE ads ADD COLUMN IF NOT EXISTS status TEXT`).catch(() => {});
  }

  // ad_images (UUID by default but we will compare as text to avoid uuid=text errors)
  await q(`
    CREATE TABLE IF NOT EXISTS ad_images(
      id BIGSERIAL PRIMARY KEY,
      ad_id UUID,
      url TEXT,
      ord INT DEFAULT 0
    );
  `).catch(() => {});

  // home slides
  await q(`
    CREATE TABLE IF NOT EXISTS home_slides(
      id UUID PRIMARY KEY,
      image_url TEXT NOT NULL,
      link_url TEXT,
      ord INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `).catch(() => {});

  // pgcrypto for gen_random_uuid
  await q(`CREATE EXTENSION IF NOT EXISTS pgcrypto`).catch(() => {});

  // ensure ads.id default if uuid
  const idInfo = await q(`
    SELECT udt_name, column_default
    FROM information_schema.columns
    WHERE table_name='ads' AND column_name='id'
    LIMIT 1
  `).catch(() => ({ rows: [] }));

  const idRow = idInfo.rows[0];
  if (idRow && idRow.udt_name === 'uuid' && !idRow.column_default) {
    await q(`ALTER TABLE ads ALTER COLUMN id SET DEFAULT gen_random_uuid()`).catch(() => {});
  }

  // if ads.status exists but null for old rows -> set published
  if (await hasColumn('ads', 'status')) {
    await q(`UPDATE ads SET status='published' WHERE status IS NULL`).catch(() => {});
  }

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

function toInt(v, d = 0) {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : d;
}

function safeFilenameUrl(file) {
  if (!file) return null;
  return '/uploads/' + file.filename;
}

// resolve category input -> id
async function resolveCategoryId(input) {
  const v = String(input || '').trim();
  if (!v) return null;

  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
  if (isUuid) return v;

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

// ===============================
// Avatar Upload (Profile)
// PUT /api/users/:id/avatar
// ===============================

// multer خاص بالصور فقط (avatar)
const avatarUpload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const ok = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.mimetype);
    cb(ok ? null : new Error('INVALID_FILE_TYPE'), ok);
  }
});

app.put('/api/users/:id/avatar', requireAuthApi, avatarUpload.single('avatar'), async (req, res) => {
  try {
    await ensureDbShape();

    const targetId = String(req.params.id || '');
    const sessionId = String(req.session.user.id || '');

    // ✅ حماية: مايمكنش تبدّل avatar ديال شي واحد آخر
    if (targetId !== sessionId) {
      return res.status(403).json({ error: 'FORBIDDEN' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'NO_FILE' });
    }

    // ✅ تأكد users table فيه avatar column
    const hasAvatar = await hasColumn('users', 'avatar');
    if (!hasAvatar) {
      await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT`).catch(() => {});
    }

    const avatarUrl = safeFilenameUrl(req.file); // "/uploads/xxxx.png"

    await q(`UPDATE users SET avatar=$1 WHERE id=$2`, [avatarUrl, targetId]);

    return res.json({ ok: true, avatar: avatarUrl });
  } catch (e) {
    console.error(e);
    const msg = String(e.message || e);
    if (msg.includes('INVALID_FILE_TYPE')) {
      return res.status(400).json({ error: 'INVALID_FILE_TYPE' });
    }
    return res.status(500).json({ error: 'SERVER_ERROR', message: msg });
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 1024 * 2 }
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
// ===============================
// PUBLIC SUPPORT (for /support page)
// ===============================

app.get('/api/support/settings', async (req, res) => {
  try {
    await ensureDbShape();

    // settings table already exists
    const r = await q(
      `SELECT support_whatsapp, support_email, support_telegram
       FROM settings
       WHERE id=1
       LIMIT 1`
    );

    const s = r.rows[0] || {};
    res.json({
      whatsapp: s.support_whatsapp || '',
      email: s.support_email || '',
      telegram: s.support_telegram || ''
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

app.get('/api/support/faq', async (req, res) => {
  try {
    await ensureDbShape();

    // table support_faq is created in admin.routes ensureSchema,
    // so here we create it too (safe) to avoid "relation does not exist"
    await q(`
      CREATE TABLE IF NOT EXISTS support_faq(
        id UUID PRIMARY KEY,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        active BOOLEAN NOT NULL DEFAULT true,
        ord INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `).catch(() => {});

    const r = await q(`
      SELECT id, question, answer, ord
      FROM support_faq
      WHERE active = true
      ORDER BY ord ASC, created_at DESC
      LIMIT 200
    `);

    res.json({ items: r.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    await ensureDbShape();
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
    res.status(500).json({ error: 'SERVER_ERROR', message: String(e.message || e) });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    await ensureDbShape();

    const hasActive = await hasColumn('categories', 'active');
    const hasOrd = await hasColumn('categories', 'ord');
    const hasCreatedAt = await hasColumn('categories', 'created_at');

    const result = await q(`
      SELECT id, name, key
      FROM categories
      ${hasActive ? 'WHERE COALESCE(active,true)=true' : ''}
      ORDER BY
        ${hasOrd ? 'ord ASC,' : ''}
        ${hasCreatedAt ? 'created_at DESC' : 'id ASC'}
    `);

    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR', message: String(e.message || e) });
  }
});

app.get('/api/ads/:id', async (req, res) => {
  try {
    await ensureDbShape();

    const adId = String(req.params.id);

    const r = await q(`SELECT * FROM ads WHERE id::text=$1 LIMIT 1`, [adId]);
    const ad = r.rows[0];
    if (!ad) return res.status(404).json({ error: 'NOT_FOUND' });

    // صور الإعلان
    const imgs = await q(
      `SELECT id, url, ord
       FROM ad_images
       WHERE ad_id::text=$1
       ORDER BY ord ASC`,
      [adId]
    );
    const images = imgs.rows.map(x => ({ id: x.id, url: x.url, ord: x.ord }));

    // owner phone
    let owner = null;
    if (ad.user_id) {
      const u = await q(
        `SELECT id,name,phone,city FROM users WHERE id::text=$1 LIMIT 1`,
        [String(ad.user_id)]
      );
      owner = u.rows[0] || null;
    }

    res.json({
      ...ad,
      image: images[0]?.url || null,
      images, // [{id,url,ord}]
      owner: owner ? { id: owner.id, name: owner.name, phone: owner.phone, city: owner.city } : null
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR', message: String(e.message || e) });
  }
});


// hero slides
app.get('/api/home/slides', async (req, res) => {
  try {
    await ensureDbShape();
    const r = await q(`
      SELECT id, image_url as "imageUrl", COALESCE(link_url,'') as "linkUrl", ord
      FROM home_slides
      ORDER BY ord ASC, created_at DESC
      LIMIT 20
    `);
    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// Ads list (supports ?featured=true&limit=..&q=..&category=..&city=..)
app.get('/api/ads', async (req, res) => {
  try {
    await ensureDbShape();

    const { q: query, category, city, limit, featured } = req.query;
    const lim = Math.min(parseInt(limit || '20', 10), 50);

    const where = [`a.status='published'`];
    const params = [];
    let i = 1;

    // search
    if (query) {
      const hasDesc = await hasColumn('ads', 'description');
      where.push(`(a.title ILIKE $${i}${hasDesc ? ` OR a.description ILIKE $${i}` : ''})`);
      params.push(`%${String(query)}%`);
      i++;
    }

    // featured
    if (String(featured || '').trim() === 'true') {
      where.push(`COALESCE(a.featured,false)=true`);
    }

// ✅ Ad details (single ad) with images + owner phone
app.get('/api/ads/:id', async (req, res) => {
  try {
    await ensureDbShape();

    const adId = String(req.params.id || '').trim();
    if (!adId) return res.status(400).json({ error: 'VALIDATION_ERROR' });

    // كنجبدو الإعلان + رقم الهاتف ديال المالك (من جدول users)
    // ملاحظة: كنستعمل ::text باش نتفاداو uuid=text error
    const adRes = await q(`
      SELECT
        a.*,
        COALESCE(u.phone, '') as owner_phone,
        COALESCE(u.name, '')  as owner_name
      FROM ads a
      LEFT JOIN users u
        ON u.id::text = a.user_id::text
      WHERE a.id::text = $1
      LIMIT 1
    `, [adId]);

    const ad = adRes.rows[0];
    if (!ad) return res.status(404).json({ error: 'NOT_FOUND' });

    // ✅ إذا بغيتي تخلي غير published يبان للعموم:
    // إلا كان عندك status وكاتستعملها
    if (String(ad.status || '') && String(ad.status) !== 'published') {
      return res.status(404).json({ error: 'NOT_FOUND' });
    }

    // الصور ديال الإعلان
    const imgs = await q(`
      SELECT url
      FROM ad_images
      WHERE ad_id::text = $1
      ORDER BY ord ASC, id ASC
    `, [adId]);

    // نرجعو JSON مرتب
    res.json({
      ...ad,
      phone: ad.owner_phone || '',         // رقم الهاتف لصاحب الإعلان
      ownerName: ad.owner_name || '',
      images: imgs.rows.map(x => x.url)     // array ديال الصور
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR', message: String(e.message || e) });
  }
});

    // category
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

    // city
    if (city) {
      where.push(`a.city ILIKE $${i}`);
      params.push(`%${String(city)}%`);
      i++;
    }

    const r = await q(`
      SELECT
        a.*,
        (
          SELECT url
          FROM ad_images
          WHERE ad_id::text = a.id::text
          ORDER BY ord ASC
          LIMIT 1
        ) as image
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

app.get('/api/ads/featured', async (req, res) => {
  try {
    await ensureDbShape();

    const r = await q(`
      SELECT
        a.*,
        (
          SELECT url
          FROM ad_images
          WHERE ad_id::text = a.id::text
          ORDER BY ord ASC
          LIMIT 1
        ) as image
      FROM ads a
      WHERE a.status='published'
        AND COALESCE(a.featured,false)=true
      ORDER BY a.created_at DESC
      LIMIT 10
    `);

    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR', message: String(e.message || e) });
  }
});

/* =========================================================
   AUTH API
   ========================================================= */

app.get('/api/auth/me', async (req, res) => {
  try {
    await ensureDbShape();
    if (!req.session.user) return res.status(401).json({ error: 'UNAUTHORIZED' });
    const u = await loadUser(req.session.user.id);
    if (!u) return res.status(401).json({ error: 'UNAUTHORIZED' });
    res.json(safeUserRow(u));
  } catch (e) {
    res.status(500).json({ error: 'SERVER_ERROR', message: String(e.message || e) });
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    await ensureDbShape();

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
    res.status(500).json({ error: 'SERVER_ERROR', message: String(e.message || e) });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    await ensureDbShape();

    const schema = z.object({
      email: z.string().email(),
      password: z.string().min(1)
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR' });

    const { email, password } = parsed.data;

    const r = await q(`
      SELECT id,password,disabled,is_admin
      FROM users
      WHERE lower(email)=lower($1)
      LIMIT 1
    `, [email.trim()]);

    const u = r.rows[0];
    if (!u) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
    if (u.disabled) return res.status(403).json({ error: 'ACCOUNT_DISABLED' });

    const ok = await bcrypt.compare(password, u.password);
    if (!ok) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });

    req.session.user = { id: u.id, is_admin: !!u.is_admin };

    const full = await loadUser(u.id);
    res.json(safeUserRow(full));
  } catch (e) {
    res.status(500).json({ error: 'SERVER_ERROR', message: String(e.message || e) });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

/* =========================================================
   ADS API (my ads / create / delete)
   - featured كيبدأ false (مايبانش مميز حتى تديرو من admin)
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
          SELECT url
          FROM ad_images
          WHERE ad_id::text = a.id::text
          ORDER BY ord ASC
          LIMIT 1
        ) as image
      FROM ads a
      WHERE a.user_id::text = $1
      ORDER BY a.created_at DESC
    `, [userId]);

    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR', message: String(e.message || e) });
  }
});

app.put('/api/ads/:id', requireAuthApi, upload.fields([
  { name: 'images', maxCount: 6 },
  { name: 'video', maxCount: 1 }
]), async (req, res) => {
  try {
    await ensureDbShape();

    const adId = String(req.params.id);
    const userId = String(req.session.user.id);

    // verify owner
    const own = await q(`SELECT id,user_id FROM ads WHERE id::text=$1 LIMIT 1`, [adId]);
    if (!own.rows[0]) return res.status(404).json({ error: 'NOT_FOUND' });
    if (String(own.rows[0].user_id) !== userId) return res.status(403).json({ error: 'FORBIDDEN' });

    // validate
    const schema = z.object({
      title: z.string().min(2),
      description: z.string().min(3),
      price: z.coerce.number().min(0),
      city: z.string().min(1),
      category: z.string().min(1)
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR', details: parsed.error.issues });

    const { title, description, price, city, category } = parsed.data;

    // category
    const hasCategoryId = await hasColumn('ads', 'category_id');
    const hasCategory = await hasColumn('ads', 'category');

    let categoryId = null;
    if (hasCategoryId) {
      categoryId = await resolveCategoryId(category);
      if (!categoryId) return res.status(400).json({ error: 'CATEGORY_NOT_FOUND' });
    }

    // update main ad
    if (hasCategoryId) {
      await q(
        `UPDATE ads
         SET title=$1, description=$2, price=$3, city=$4, category_id=$5, updated_at=NOW()
         WHERE id::text=$6`,
        [title, description, price, city, String(categoryId), adId]
      );
    } else if (hasCategory) {
      await q(
        `UPDATE ads
         SET title=$1, description=$2, price=$3, city=$4, category=$5, updated_at=NOW()
         WHERE id::text=$6`,
        [title, description, price, city, String(category), adId]
      );
    } else {
      return res.status(500).json({ error: 'ADS_CATEGORY_COLUMN_MISSING' });
    }

    // add new images (append)
    const newImages = (req.files?.images || []);
    if (newImages.length) {
      const maxOrdR = await q(
        `SELECT COALESCE(MAX(ord), -1) as m FROM ad_images WHERE ad_id::text=$1`,
        [adId]
      );
      let ord = (maxOrdR.rows[0]?.m ?? -1) + 1;

      for (const f of newImages) {
        await q(
          `INSERT INTO ad_images(ad_id,url,ord) VALUES($1,$2,$3)`,
          [adId, safeFilenameUrl(f), ord++]
        );
      }
    }

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR', message: String(e.message || e) });
  }
});

app.delete('/api/ads/:id/images/:imgId', requireAuthApi, async (req, res) => {
  try {
    await ensureDbShape();

    const adId = String(req.params.id);
    const imgId = String(req.params.imgId);
    const userId = String(req.session.user.id);

    // verify owner
    const own = await q(`SELECT id,user_id FROM ads WHERE id::text=$1 LIMIT 1`, [adId]);
    if (!own.rows[0]) return res.status(404).json({ error: 'NOT_FOUND' });
    if (String(own.rows[0].user_id) !== userId) return res.status(403).json({ error: 'FORBIDDEN' });

    await q(`DELETE FROM ad_images WHERE id::text=$1 AND ad_id::text=$2`, [imgId, adId]);

    res.json({ ok: true });
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
    for (const f of images) if (f.size > maxImageBytes) return res.status(400).json({ error: 'IMAGE_TOO_LARGE' });

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
      await client.query('begin');

      let adRes;

      // ✅ featured starts FALSE always
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
        await client.query('rollback');
        return res.status(500).json({ error: 'ADS_CATEGORY_COLUMN_MISSING' });
      }

      const adId = adRes.rows[0].id;

      for (let idx = 0; idx < images.length; idx++) {
        const url = safeFilenameUrl(images[idx]);
        await client.query(
          `INSERT INTO ad_images (ad_id,url,ord) VALUES ($1,$2,$3)`,
          [adId, url, idx]
        );
      }

      await client.query('commit');
      res.json({ ok: true, ad: { id: adId } });

    } catch (e) {
      await client.query('rollback');
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

    const adId = req.params.id;
    const userId = String(req.session.user.id);

    const hasUserId = await hasColumn('ads', 'user_id');
    if (!hasUserId) return res.status(500).json({ error: 'ADS_USER_ID_MISSING' });

    const r = await q('SELECT id,user_id FROM ads WHERE id::text=$1', [String(adId)]);
    if (!r.rows[0]) return res.status(404).json({ error: 'NOT_FOUND' });

    if (String(r.rows[0].user_id) !== userId) return res.status(403).json({ error: 'FORBIDDEN' });

    await q('DELETE FROM ad_images WHERE ad_id::text=$1', [String(adId)]).catch(() => {});
    await q('DELETE FROM ads WHERE id::text=$1', [String(adId)]);

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
  } catch {
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
    app.listen(PORT, () => {
      console.log(`✅ Samsar server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Startup failed:', err);
    process.exit(1);
  }
}

start();