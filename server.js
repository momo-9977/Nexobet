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

/* -------------------- Directories -------------------- */

const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

/* -------------------- Middlewares -------------------- */

app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('dev'));

const CORS_ORIGIN =
  process.env.BASE_URL && process.env.BASE_URL.trim()
    ? process.env.BASE_URL.trim()
    : true;

app.use(cors({
  origin: CORS_ORIGIN,
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.set('trust proxy', 1);

/* -------------------- Sessions -------------------- */

app.use(session({
  store: new pgSession({
    pool,
    tableName: 'session'
  }),
  secret: process.env.SESSION_SECRET || 'change_me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: false,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 14
  }
}));

app.set('pool', pool);

/* -------------------- Static -------------------- */

app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(PUBLIC_DIR));

/* -------------------- Core Settings -------------------- */

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

async function hasColumn(table, col) {
  const r = await q(
    `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2 LIMIT 1`,
    [table, col]
  );
  return !!r.rows[0];
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

app.get('/api/settings', async (req, res) => {
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
});

app.get('/api/categories', async (req, res) => {
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
});

app.get('/api/ads', async (req, res) => {
  const { q: query, category, city, limit } = req.query;

  const lim = Math.min(parseInt(limit || '20', 10), 50);
  const where = [`a.status='published'`];
  const params = [];
  let i = 1;

  if (query) {
    where.push(`(a.title ILIKE $${i} OR a.description ILIKE $${i})`);
    params.push(`%${query}%`);
    i++;
  }

  if (category) {
    where.push(`a.category_id=$${i}`);
    params.push(category);
    i++;
  }

  if (city) {
    where.push(`a.city ILIKE $${i}`);
    params.push(city);
    i++;
  }

  const r = await q(`
    SELECT a.*
    FROM ads a
    WHERE ${where.join(' AND ')}
    ORDER BY a.created_at DESC
    LIMIT ${lim}
  `, params);

  res.json(r.rows);
});

/* =========================================================
   AUTH API
   ========================================================= */

app.get('/api/auth/me', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'UNAUTHORIZED' });
  const u = await loadUser(req.session.user.id);
  if (!u) return res.status(401).json({ error: 'UNAUTHORIZED' });
  res.json(safeUserRow(u));
});

app.post('/api/auth/register', async (req, res) => {
  const s = await getSettings();
  if (!s || s.allow_register !== true) {
    return res.status(403).json({ error: 'REGISTER_DISABLED' });
  }

  const schema = z.object({
    name: z.string().min(2),
    email: z.string().email(),
    password: z.string().min(6)
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR' });

  const { name, email, password } = parsed.data;

  const exists = await q(
    'SELECT id FROM users WHERE lower(email)=lower($1)',
    [email.trim()]
  );

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
});

app.post('/api/auth/login', async (req, res) => {
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
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});
/* =========================================================
   ADS API
   ========================================================= */

app.get('/api/my/ads', requireAuthApi, async (req, res) => {
  const userId = req.session.user.id;

  const r = await q(`
    SELECT *
    FROM ads
    WHERE user_id=$1
    ORDER BY created_at DESC
  `, [userId]);

  res.json(r.rows);
});

app.post('/api/ads',
  requireAuthApi,
  upload.fields([
    { name: 'images', maxCount: 6 },
    { name: 'video', maxCount: 1 }
  ]),
  async (req, res) => {

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
    if (!parsed.success) {
      return res.status(400).json({ error: 'VALIDATION_ERROR' });
    }

    const images = (req.files?.images || []).slice(0, maxImages);
    const videoFile =
      (req.files?.video && req.files.video[0])
        ? req.files.video[0]
        : null;

    const maxImageBytes = maxImageMb * 1024 * 1024;
    for (const f of images) {
      if (f.size > maxImageBytes) {
        return res.status(400).json({ error: 'IMAGE_TOO_LARGE' });
      }
    }

    if (videoFile) {
      const maxVideoBytes = maxVideoMb * 1024 * 1024;
      if (videoFile.size > maxVideoBytes) {
        return res.status(400).json({ error: 'VIDEO_TOO_LARGE' });
      }
    }

    const userId = req.session.user.id;
    const { title, description, price, city, category } = parsed.data;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const adRes = await client.query(`
        INSERT INTO ads
          (user_id,title,description,price,city,category_id,status,featured,video_url)
        VALUES
          ($1,$2,$3,$4,$5,$6,'published',false,$7)
        RETURNING id
      `, [
        userId,
        title,
        description,
        price,
        city,
        category,
        videoFile ? safeFilenameUrl(videoFile) : null
      ]);

      const adId = adRes.rows[0].id;

      for (let idx = 0; idx < images.length; idx++) {
        await client.query(
          `INSERT INTO ad_images (ad_id,url,ord)
           VALUES ($1,$2,$3)`,
          [adId, safeFilenameUrl(images[idx]), idx]
        );
      }

      await client.query('COMMIT');

      res.json({ ok: true, ad: { id: adId } });

    } catch (e) {
      await client.query('ROLLBACK');
      console.error(e);
      res.status(500).json({ error: 'SERVER_ERROR' });
    } finally {
      client.release();
    }
  }
);

app.delete('/api/ads/:id', requireAuthApi, async (req, res) => {
  const adId = req.params.id;
  const userId = req.session.user.id;

  const r = await q(
    'SELECT id,user_id FROM ads WHERE id=$1',
    [adId]
  );

  if (!r.rows[0]) return res.status(404).json({ error: 'NOT_FOUND' });

  if (String(r.rows[0].user_id) !== String(userId)) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }

  await q('DELETE FROM ad_images WHERE ad_id=$1', [adId]);
  await q('DELETE FROM ads WHERE id=$1', [adId]);

  res.json({ ok: true });
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
   Start
   ========================================================= */

app.use('/api/admin', adminRoutes);

app.listen(PORT, () => {
  console.log(`✅ Samsar server running on http://localhost:${PORT}`);
});