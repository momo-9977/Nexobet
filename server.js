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

const { pool, q } = require('./db'); // db.js: exports { pool, q(text, params) }

const app = express();
const PORT = process.env.PORT || 3000;

const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

/* -------------------- Middlewares -------------------- */
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('dev'));

app.use(cors({
  origin: process.env.BASE_URL || true,
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Sessions (Postgres)
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
    secure: String(process.env.COOKIE_SECURE || 'false') === 'true',
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 14
  }
}));

// Static
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(PUBLIC_DIR));

/* -------------------- Helpers -------------------- */
async function getSettings() {
  const r = await q('select * from settings where id=1');
  return r.rows[0];
}

function safeUserRow(u) {
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    avatar: u.avatar_url,
    role: u.role,
    status: u.status,
    verified: u.verified,
    createdAt: u.created_at
  };
}

async function loadUser(userId) {
  const r = await q(
    'select id,name,email,phone,avatar_url,role,status,verified,created_at from users where id=$1',
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

function requireAdmin(req, res, next) {
  const u = req.session.user;
  if (!u) return res.status(401).json({ error: 'UNAUTHORIZED' });
  if (u.role !== 'admin') return res.status(403).json({ error: 'FORBIDDEN' });
  next();
}

// ✅ حماية صفحة /admin (page) — ماشي API
function requireAdminPage(req, res, next) {
  const u = req.session.user;
  if (!u) return res.redirect('/login');
  if (u.role !== 'admin') return res.redirect('/');
  next();
}

function pickId(row) {
  return row?.id || row?._id || row?.uuid || null;
}

function toInt(v, d = 0) {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : d;
}

function toBool(v) {
  return v === true || v === 'true' || v === '1' || v === 1;
}

function safeFilenameUrl(file) {
  if (!file) return null;
  return '/uploads/' + file.filename;
}

/* -------------------- Upload (Multer) -------------------- */
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
  limits: { fileSize: 1024 * 1024 * 1024 * 2 } // سقف كبير، كنراقبو per-route
});

/* =========================================================
   صفحات الموقع (Routes بلا .html)
   - Public: / /categories /ad /support /login /register
   - Protected: /post-ad /profile /edit-ad
   - Admin: /admin
   ========================================================= */

// Public pages
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/categories', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'categories.html')));
app.get('/ad', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'ad.html')));
app.get('/support', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'support.html')));
app.get('/login', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'register.html')));

// Protected pages
app.get('/post-ad', requireAuthPage, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'post-ad.html')));
app.get('/profile', requireAuthPage, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'profile.html')));
app.get('/edit-ad', requireAuthPage, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'edit-ad.html')));

// ✅ Admin page (protected)
app.get('/admin', requireAdminPage, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));

/* =========================================================
   PUBLIC API (لي كتشوفو الصفحات)
   ========================================================= */

/** SETTINGS (branding/support/uploads limits) */
app.get('/api/settings', async (req, res) => {
  const s = await getSettings();
  res.json({
    platformName: s.platform_name,
    subtitle: s.subtitle,
    logoUrl: s.logo_url,
    supportWhatsapp: s.support_whatsapp,
    supportEmail: s.support_email,
    allowRegister: s.allow_register,
    uploads: { maxImages: s.max_images, maxImageMb: s.max_image_mb, maxVideoMb: s.max_video_mb }
  });
});

/** HOME SLIDES (banner) */
app.get('/api/home/slides', async (req, res) => {
  const r = await q('select id,image_url,link_url,ord from home_slides order by ord asc, created_at desc');
  res.json(r.rows.map(x => ({
    id: x.id,
    imageUrl: x.image_url,
    linkUrl: x.link_url,
    order: x.ord
  })));
});

/** SUPPORT public */
app.get('/api/support/settings', async (req, res) => {
  const s = await getSettings();
  res.json({ whatsapp: s.support_whatsapp, email: s.support_email });
});

app.get('/api/support/faq', async (req, res) => {
  const r = await q('select * from support_faq where active=true order by ord asc');
  res.json(r.rows);
});

/** CATEGORIES public */
app.get('/api/categories', async (req, res) => {
  const r = await q(`
    select c.id, c.name, c.description, c.image_url, c.ord, c.active,
      (select count(*)::int from ads a where a.category_id=c.id and a.status='published') as ads_count
    from categories c
    order by c.ord asc, c.created_at desc
  `);

  res.json(r.rows.map(c => ({
    id: c.id,
    name: c.name,
    description: c.description,
    image: c.image_url,
    order: c.ord,
    active: c.active,
    adsCount: c.ads_count
  })));
});

/** ADS public list (search/filter/featured/latest) */
app.get('/api/ads', async (req, res) => {
  const { q: query, category, city, featured, limit } = req.query;

  const lim = Math.min(parseInt(limit || '20', 10), 50);
  const where = [`a.status='published'`];
  const params = [];
  let i = 1;

  if (query) { where.push(`(a.title ilike $${i} or a.description ilike $${i})`); params.push(`%${query}%`); i++; }
  if (category) { where.push(`a.category_id=$${i}`); params.push(category); i++; }
  if (city) { where.push(`a.city ilike $${i}`); params.push(city); i++; }
  if (featured === 'true') where.push(`a.featured=true`);
  if (featured === 'false') where.push(`a.featured=false`);

  const r = await q(`
    select a.*, u.name as owner_name, u.email as owner_email, u.phone as owner_phone
    from ads a
    left join users u on u.id=a.user_id
    where ${where.join(' and ')}
    order by a.featured desc, a.created_at desc
    limit ${lim}
  `, params);

  const ads = r.rows;
  const ids = ads.map(a => a.id);

  let imagesByAd = {};
  if (ids.length) {
    const im = await q(
      `select ad_id,url,ord from ad_images where ad_id = any($1::uuid[]) order by ord asc`,
      [ids]
    );
    imagesByAd = im.rows.reduce((acc, row) => {
      acc[row.ad_id] = acc[row.ad_id] || [];
      acc[row.ad_id].push(row.url);
      return acc;
    }, {});
  }

  res.json(ads.map(a => ({
    id: a.id,
    title: a.title,
    description: a.description,
    price: a.price,
    city: a.city,
    category: a.category_id,
    status: a.status,
    featured: a.featured,
    createdAt: a.created_at,
    images: imagesByAd[a.id] || [],
    video: a.video_url || null,
    owner_name: a.owner_name || '',
    owner_email: a.owner_email || '',
    owner_phone: a.owner_phone || ''
  })));
});

/** AD details public */
app.get('/api/ads/:id', async (req, res) => {
  const adId = req.params.id;

  const r = await q(`
    select a.*, u.name as owner_name, u.email as owner_email, u.phone as owner_phone
    from ads a
    left join users u on u.id=a.user_id
    where a.id=$1
  `, [adId]);

  if (!r.rows[0]) return res.status(404).json({ error: 'NOT_FOUND' });

  const ad = r.rows[0];
  const im = await q(`select url from ad_images where ad_id=$1 order by ord asc`, [adId]);

  res.json({
    id: ad.id,
    title: ad.title,
    description: ad.description,
    price: ad.price,
    city: ad.city,
    category: ad.category_id,
    status: ad.status,
    featured: ad.featured,
    images: im.rows.map(x => x.url),
    video: ad.video_url,
    owner_name: ad.owner_name || '',
    owner_email: ad.owner_email || '',
    owner_phone: ad.owner_phone || '',
    createdAt: ad.created_at
  });
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
  if (!s.allow_register) return res.status(403).json({ error: 'REGISTER_DISABLED' });

  const schema = z.object({
    name: z.string().min(2),
    email: z.string().email(),
    password: z.string().min(6),
    phone: z.string().optional().nullable()
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR', details: parsed.error.issues });

  const { name, email, password, phone } = parsed.data;

  const exists = await q('select id from users where email=$1', [email.toLowerCase()]);
  if (exists.rows[0]) return res.status(409).json({ error: 'EMAIL_EXISTS' });

  const hash = await bcrypt.hash(password, 10);

  const r = await q(`
    insert into users (name,email,password_hash,phone,role,status,verified)
    values ($1,$2,$3,$4,'user','active',true)
    returning id
  `, [name, email.toLowerCase(), hash, phone || null]);

  const userId = r.rows[0].id;
  req.session.user = { id: userId, role: 'user' };

  const u = await loadUser(userId);
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
    'select id,email,password_hash,role,status from users where email=$1',
    [email.toLowerCase()]
  );

  const u = r.rows[0];
  if (!u) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
  if (u.status && u.status !== 'active') return res.status(403).json({ error: 'ACCOUNT_DISABLED' });

  const ok = await bcrypt.compare(password, u.password_hash);
  if (!ok) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });

  req.session.user = { id: u.id, role: u.role || 'user' };
  const full = await loadUser(u.id);
  res.json(safeUserRow(full));
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

/** Change password (profile/security) */
app.patch('/api/auth/password', requireAuthApi, async (req, res) => {
  const schema = z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(6)
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR' });

  const { currentPassword, newPassword } = parsed.data;

  const r = await q('select id,password_hash from users where id=$1', [req.session.user.id]);
  const u = r.rows[0];
  if (!u) return res.status(401).json({ error: 'UNAUTHORIZED' });

  const ok = await bcrypt.compare(currentPassword, u.password_hash);
  if (!ok) return res.status(401).json({ error: 'WRONG_PASSWORD' });

  const hash = await bcrypt.hash(newPassword, 10);
  await q('update users set password_hash=$1 where id=$2', [hash, req.session.user.id]);

  res.json({ ok: true });
});

/* =========================================================
   ✅ ADMIN AUTH (مخصص للـ /admin.html)
   لازم ENV:
   ADMIN_EMAIL=...
   ADMIN_PASSWORD_HASH=... (bcrypt hash)
   ========================================================= */

app.post('/api/admin/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim();
    const password = String(req.body.password || '');

    const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
    const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;

    if (!ADMIN_EMAIL || !ADMIN_PASSWORD_HASH) {
      return res.status(500).json({ error: 'ADMIN_ENV_MISSING' });
    }

    if (!email || !password) return res.status(400).json({ error: 'MISSING_FIELDS' });
    if (email !== ADMIN_EMAIL) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });

    const ok = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
    if (!ok) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });

    req.session.user = { id: 'admin', role: 'admin', email: ADMIN_EMAIL };
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

/* =========================================================
   USER API (Profile)
   ========================================================= */

app.put('/api/users/:id', requireAuthApi, async (req, res) => {
  const userId = req.params.id;

  // user يقدر يبدّل غير راسو، admin يقدر يبدّل أي واحد
  const isAdmin = req.session.user.role === 'admin';
  if (!isAdmin && String(req.session.user.id) !== String(userId)) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }

  const schema = z.object({
    phone: z.string().optional().nullable()
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR' });

  await q('update users set phone=$1 where id=$2', [parsed.data.phone || null, userId]);

  const u = await loadUser(userId);
  res.json(safeUserRow(u));
});

app.put('/api/users/:id/avatar', requireAuthApi, upload.single('avatar'), async (req, res) => {
  const userId = req.params.id;

  const isAdmin = req.session.user.role === 'admin';
  if (!isAdmin && String(req.session.user.id) !== String(userId)) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }

  const url = safeFilenameUrl(req.file);
  if (!url) return res.status(400).json({ error: 'NO_FILE' });

  await q('update users set avatar_url=$1 where id=$2', [url, userId]);
  res.json({ ok: true, avatar: url });
});

/* =========================================================
   ADS API (Create/Edit/Delete/MyAds)
   ========================================================= */

// My ads (profile)
app.get('/api/my/ads', requireAuthApi, async (req, res) => {
  const userId = req.session.user.id;
  const r = await q(`
    select a.*
    from ads a
    where a.user_id=$1
    order by a.created_at desc
  `, [userId]);

  const ads = r.rows;
  const ids = ads.map(a => a.id);

  let imagesByAd = {};
  if (ids.length) {
    const im = await q(`select ad_id,url,ord from ad_images where ad_id = any($1::uuid[]) order by ord asc`, [ids]);
    imagesByAd = im.rows.reduce((acc, row) => {
      acc[row.ad_id] = acc[row.ad_id] || [];
      acc[row.ad_id].push(row.url);
      return acc;
    }, {});
  }

  res.json(ads.map(a => ({
    id: a.id,
    title: a.title,
    description: a.description,
    price: a.price,
    city: a.city,
    category: a.category_id,
    status: a.status,
    featured: a.featured,
    createdAt: a.created_at,
    images: imagesByAd[a.id] || [],
    video: a.video_url || null
  })));
});

// Create ad (post-ad.html) — multipart: images[], video
app.post('/api/ads', requireAuthApi, upload.fields([
  { name: 'images', maxCount: 6 },
  { name: 'video', maxCount: 1 }
]), async (req, res) => {
  const s = await getSettings();

  const maxImages = toInt(s.max_images, 6);
  const maxImageMb = toInt(s.max_image_mb, 10);
  const maxVideoMb = toInt(s.max_video_mb, 1024);

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

  // validate sizes
  const maxImageBytes = maxImageMb * 1024 * 1024;
  for (const f of images) {
    if (f.size > maxImageBytes) return res.status(400).json({ error: 'IMAGE_TOO_LARGE' });
  }

  if (videoFile) {
    const maxVideoBytes = maxVideoMb * 1024 * 1024;
    if (videoFile.size > maxVideoBytes) return res.status(400).json({ error: 'VIDEO_TOO_LARGE' });
  }

  const userId = req.session.user.id;
  const { title, description, price, city, category } = parsed.data;

  // Save
  const client = await pool.connect();
  try {
    await client.query('begin');

    const adRes = await client.query(`
      insert into ads (user_id,title,description,price,city,category_id,status,featured,video_url)
      values ($1,$2,$3,$4,$5,$6,'published',false,$7)
      returning id
    `, [userId, title, description, price, city, category, videoFile ? safeFilenameUrl(videoFile) : null]);

    const adId = adRes.rows[0].id;

    // images
    for (let idx = 0; idx < images.length; idx++) {
      const url = safeFilenameUrl(images[idx]);
      await client.query(
        `insert into ad_images (ad_id,url,ord) values ($1,$2,$3)`,
        [adId, url, idx]
      );
    }

    await client.query('commit');
    res.json({ ok: true, ad: { id: adId } });
  } catch (e) {
    await client.query('rollback');
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  } finally {
    client.release();
  }
});

// Update ad (edit-ad.html) — multipart optional
app.put('/api/ads/:id', requireAuthApi, upload.fields([
  { name: 'images', maxCount: 6 },
  { name: 'video', maxCount: 1 }
]), async (req, res) => {
  const adId = req.params.id;
  const userId = req.session.user.id;
  const isAdmin = req.session.user.role === 'admin';

  const schema = z.object({
    title: z.string().min(2),
    description: z.string().min(0).optional(),
    price: z.coerce.number().min(0).optional(),
    city: z.string().min(0).optional(),
    category: z.string().min(0).optional()
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR' });

  const ownerRes = await q('select id,user_id from ads where id=$1', [adId]);
  const adRow = ownerRes.rows[0];
  if (!adRow) return res.status(404).json({ error: 'NOT_FOUND' });

  if (!isAdmin && String(adRow.user_id) !== String(userId)) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }

  const images = (req.files?.images || []);
  const videoFile = (req.files?.video && req.files.video[0]) ? req.files.video[0] : null;

  const client = await pool.connect();
  try {
    await client.query('begin');

    const upd = parsed.data;
    await client.query(`
      update ads set
        title=$2,
        description=$3,
        price=$4,
        city=$5,
        category_id=$6,
        video_url = coalesce($7, video_url),
        updated_at = now()
      where id=$1
    `, [
      adId,
      upd.title,
      upd.description ?? '',
      (upd.price ?? 0),
      upd.city ?? '',
      upd.category ?? null,
      videoFile ? safeFilenameUrl(videoFile) : null
    ]);

    // إذا جاو صور جداد => نعوضوهم كاملين
    if (images.length) {
      await client.query('delete from ad_images where ad_id=$1', [adId]);
      for (let idx = 0; idx < images.length; idx++) {
        await client.query(
          `insert into ad_images (ad_id,url,ord) values ($1,$2,$3)`,
          [adId, safeFilenameUrl(images[idx]), idx]
        );
      }
    }

    await client.query('commit');
    res.json({ ok: true });
  } catch (e) {
    await client.query('rollback');
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  } finally {
    client.release();
  }
});

// Delete ad
app.delete('/api/ads/:id', requireAuthApi, async (req, res) => {
  const adId = req.params.id;
  const userId = req.session.user.id;
  const isAdmin = req.session.user.role === 'admin';

  const r = await q('select id,user_id from ads where id=$1', [adId]);
  if (!r.rows[0]) return res.status(404).json({ error: 'NOT_FOUND' });

  if (!isAdmin && String(r.rows[0].user_id) !== String(userId)) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }

  await q('delete from ad_images where ad_id=$1', [adId]);
  await q('delete from ads where id=$1', [adId]);

  res.json({ ok: true });
});

// Toggle visibility
app.patch('/api/ads/:id/visibility', requireAuthApi, async (req, res) => {
  const adId = req.params.id;
  const userId = req.session.user.id;
  const isAdmin = req.session.user.role === 'admin';

  const schema = z.object({ status: z.enum(['published', 'hidden']) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR' });

  const r = await q('select id,user_id from ads where id=$1', [adId]);
  if (!r.rows[0]) return res.status(404).json({ error: 'NOT_FOUND' });

  if (!isAdmin && String(r.rows[0].user_id) !== String(userId)) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }

  await q('update ads set status=$1, updated_at=now() where id=$2', [parsed.data.status, adId]);
  res.json({ ok: true });
});

// Mark sold
app.patch('/api/ads/:id/sold', requireAuthApi, async (req, res) => {
  const adId = req.params.id;
  const userId = req.session.user.id;
  const isAdmin = req.session.user.role === 'admin';

  const r = await q('select id,user_id from ads where id=$1', [adId]);
  if (!r.rows[0]) return res.status(404).json({ error: 'NOT_FOUND' });

  if (!isAdmin && String(r.rows[0].user_id) !== String(userId)) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }

  await q(`update ads set status='sold', updated_at=now() where id=$1`, [adId]);
  res.json({ ok: true });
});

/* =========================================================
   Favorites / Reports (ad page)
   ========================================================= */

app.post('/api/favorites', requireAuthApi, async (req, res) => {
  const schema = z.object({ adId: z.string().min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR' });

  const userId = req.session.user.id;
  const adId = parsed.data.adId;

  await q(`
    insert into favorites (user_id, ad_id)
    values ($1,$2)
    on conflict (user_id, ad_id) do nothing
  `, [userId, adId]);

  res.json({ ok: true });
});

app.get('/api/favorites', requireAuthApi, async (req, res) => {
  const userId = req.session.user.id;

  const r = await q(`
    select f.id, f.ad_id, a.title, a.price, a.city
    from favorites f
    join ads a on a.id=f.ad_id
    where f.user_id=$1
    order by f.created_at desc
  `, [userId]);

  res.json(r.rows.map(x => ({
    id: x.id,
    adId: x.ad_id,
    title: x.title,
    price: x.price,
    city: x.city
  })));
});

app.delete('/api/favorites/:id', requireAuthApi, async (req, res) => {
  const userId = req.session.user.id;
  const favId = req.params.id;

  await q('delete from favorites where id=$1 and user_id=$2', [favId, userId]);
  res.json({ ok: true });
});

// (اختياري) check if ad is favorited
app.get('/api/ads/:id/favorite', requireAuthApi, async (req, res) => {
  const userId = req.session.user.id;
  const adId = req.params.id;

  const r = await q('select 1 from favorites where user_id=$1 and ad_id=$2', [userId, adId]);
  res.json({ favorite: !!r.rows[0] });
});

app.post('/api/reports', requireAuthApi, async (req, res) => {
  const schema = z.object({
    adId: z.string().min(1),
    reason: z.string().min(2)
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR' });

  const userId = req.session.user.id;
  await q(`
    insert into reports (user_id, ad_id, reason)
    values ($1,$2,$3)
  `, [userId, parsed.data.adId, parsed.data.reason]);

  res.json({ ok: true });
});

/* =========================================================
   Premium (profile)
   ========================================================= */

app.post('/api/premium/buy', requireAuthApi, async (req, res) => {
  const schema = z.object({
    adId: z.string().min(1),
    plan: z.enum(['featured_1d', 'featured_7d', 'featured_30d'])
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR' });

  // هنا نخليها "طلب" فقط باش تربطها بالدفع لاحقاً
  const userId = req.session.user.id;

  await q(`
    insert into premium_orders (user_id, ad_id, plan, status)
    values ($1,$2,$3,'pending')
  `, [userId, parsed.data.adId, parsed.data.plan]);

  res.json({ ok: true });
});

app.get('/api/premium/history', requireAuthApi, async (req, res) => {
  const userId = req.session.user.id;
  const r = await q(`
    select * from premium_orders
    where user_id=$1
    order by created_at desc
    limit 100
  `, [userId]);

  res.json(r.rows);
});

/* =========================================================
   Notifications (profile)
   ========================================================= */

app.get('/api/notifications', requireAuthApi, async (req, res) => {
  const userId = req.session.user.id;
  const r = await q(`
    select id,title,body,read,created_at
    from notifications
    where user_id=$1
    order by created_at desc
    limit 100
  `, [userId]);

  res.json(r.rows.map(n => ({
    id: n.id,
    title: n.title,
    body: n.body,
    read: n.read,
    createdAt: n.created_at
  })));
});

app.post('/api/notifications/read-all', requireAuthApi, async (req, res) => {
  const userId = req.session.user.id;
  await q(`update notifications set read=true where user_id=$1`, [userId]);
  res.json({ ok: true });
});

/* =========================================================
   ADMIN API (لوحة التحكم) — محمية بـ requireAdmin
   ========================================================= */

// Settings update (branding/uploads/support)
app.put('/api/admin/settings', requireAdmin, async (req, res) => {
  const schema = z.object({
    platformName: z.string().min(1).optional(),
    subtitle: z.string().optional(),
    logoUrl: z.string().optional().nullable(),
    supportWhatsapp: z.string().optional().nullable(),
    supportEmail: z.string().optional().nullable(),
    allowRegister: z.boolean().optional(),
    uploads: z.object({
      maxImages: z.number().int().min(1).max(10).optional(),
      maxImageMb: z.number().int().min(1).max(50).optional(),
      maxVideoMb: z.number().int().min(10).max(2048).optional()
    }).optional()
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR', details: parsed.error.issues });

  const data = parsed.data;

  await q(`
    update settings set
      platform_name = coalesce($1, platform_name),
      subtitle = coalesce($2, subtitle),
      logo_url = coalesce($3, logo_url),
      support_whatsapp = coalesce($4, support_whatsapp),
      support_email = coalesce($5, support_email),
      allow_register = coalesce($6, allow_register),
      max_images = coalesce($7, max_images),
      max_image_mb = coalesce($8, max_image_mb),
      max_video_mb = coalesce($9, max_video_mb),
      updated_at = now()
    where id=1
  `, [
    data.platformName ?? null,
    data.subtitle ?? null,
    data.logoUrl ?? null,
    data.supportWhatsapp ?? null,
    data.supportEmail ?? null,
    typeof data.allowRegister === 'boolean' ? data.allowRegister : null,
    data.uploads?.maxImages ?? null,
    data.uploads?.maxImageMb ?? null,
    data.uploads?.maxVideoMb ?? null
  ]);

  res.json({ ok: true });
});

// Categories CRUD
app.post('/api/admin/categories', requireAdmin, upload.single('image'), async (req, res) => {
  const schema = z.object({
    name: z.string().min(2),
    description: z.string().optional().nullable(),
    active: z.string().optional(),
    order: z.string().optional()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR' });

  const imgUrl = req.file ? safeFilenameUrl(req.file) : null;

  const r = await q(`
    insert into categories (name,description,image_url,active,ord)
    values ($1,$2,$3,$4,$5)
    returning id
  `, [
    parsed.data.name,
    parsed.data.description || '',
    imgUrl,
    toBool(parsed.data.active),
    toInt(parsed.data.order, 0)
  ]);

  res.json({ ok: true, id: r.rows[0].id });
});

app.put('/api/admin/categories/:id', requireAdmin, upload.single('image'), async (req, res) => {
  const schema = z.object({
    name: z.string().min(2).optional(),
    description: z.string().optional().nullable(),
    active: z.string().optional(),
    order: z.string().optional()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR' });

  const imgUrl = req.file ? safeFilenameUrl(req.file) : null;

  await q(`
    update categories set
      name = coalesce($2,name),
      description = coalesce($3,description),
      image_url = coalesce($4,image_url),
      active = coalesce($5,active),
      ord = coalesce($6,ord),
      updated_at = now()
    where id=$1
  `, [
    req.params.id,
    parsed.data.name ?? null,
    parsed.data.description ?? null,
    imgUrl,
    parsed.data.active !== undefined ? toBool(parsed.data.active) : null,
    parsed.data.order !== undefined ? toInt(parsed.data.order, 0) : null
  ]);

  res.json({ ok: true });
});

app.delete('/api/admin/categories/:id', requireAdmin, async (req, res) => {
  await q('delete from categories where id=$1', [req.params.id]);
  res.json({ ok: true });
});

// Home slides CRUD
app.post('/api/admin/home/slides', requireAdmin, upload.single('image'), async (req, res) => {
  const schema = z.object({
    linkUrl: z.string().optional().nullable(),
    order: z.string().optional()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR' });

  if (!req.file) return res.status(400).json({ error: 'NO_IMAGE' });
  const imgUrl = safeFilenameUrl(req.file);

  const r = await q(`
    insert into home_slides (image_url, link_url, ord)
    values ($1,$2,$3)
    returning id
  `, [imgUrl, parsed.data.linkUrl || null, toInt(parsed.data.order, 0)]);

  res.json({ ok: true, id: r.rows[0].id });
});

app.put('/api/admin/home/slides/:id', requireAdmin, upload.single('image'), async (req, res) => {
  const schema = z.object({
    linkUrl: z.string().optional().nullable(),
    order: z.string().optional()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR' });

  const imgUrl = req.file ? safeFilenameUrl(req.file) : null;

  await q(`
    update home_slides set
      image_url = coalesce($2, image_url),
      link_url = coalesce($3, link_url),
      ord = coalesce($4, ord),
      updated_at = now()
    where id=$1
  `, [req.params.id, imgUrl, parsed.data.linkUrl ?? null, parsed.data.order !== undefined ? toInt(parsed.data.order, 0) : null]);

  res.json({ ok: true });
});

app.delete('/api/admin/home/slides/:id', requireAdmin, async (req, res) => {
  await q('delete from home_slides where id=$1', [req.params.id]);
  res.json({ ok: true });
});

// Admin: manage users (phone / role / status / password reset)
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const r = await q(`
    select id,name,email,phone,avatar_url,role,status,verified,created_at
    from users
    order by created_at desc
    limit 200
  `);
  res.json(r.rows.map(safeUserRow));
});

app.put('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const schema = z.object({
    phone: z.string().optional().nullable(),
    role: z.enum(['user', 'admin']).optional(),
    status: z.enum(['active', 'disabled']).optional(),
    verified: z.boolean().optional()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR' });

  const d = parsed.data;
  await q(`
    update users set
      phone = coalesce($2, phone),
      role = coalesce($3, role),
      status = coalesce($4, status),
      verified = coalesce($5, verified),
      updated_at = now()
    where id=$1
  `, [req.params.id, d.phone ?? null, d.role ?? null, d.status ?? null, (typeof d.verified === 'boolean') ? d.verified : null]);

  const u = await loadUser(req.params.id);
  res.json(safeUserRow(u));
});

app.post('/api/admin/users/:id/reset-password', requireAdmin, async (req, res) => {
  const schema = z.object({ newPassword: z.string().min(6) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR' });

  const hash = await bcrypt.hash(parsed.data.newPassword, 10);
  await q('update users set password_hash=$1 where id=$2', [hash, req.params.id]);

  res.json({ ok: true });
});

/* =========================================================
   Health + Start
   ========================================================= */

app.get('/api/health', async (req, res) => {
  try {
    await q('select 1 as ok');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Samsar server running on http://localhost:${PORT}`);
});