// server.js  (Samsar - Clean Stable Version)
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

/* ================= Directories ================= */

const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

/* ================= Middlewares ================= */

app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('dev'));

app.use(cors({
  origin: IS_PROD ? process.env.BASE_URL : true,
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.set('trust proxy', 1);

/* ================= Sessions ================= */

if (IS_PROD && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET is required in production');
}

app.use(session({
  store: new pgSession({ pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET || 'dev_secret_change_me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 14
  }
}));

app.set('pool', pool);

/* ================= Static ================= */

app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(PUBLIC_DIR));

/* ================= DB Safety ================= */

async function ensureDb() {
  await q(`CREATE EXTENSION IF NOT EXISTS pgcrypto`).catch(()=>{});

  await q(`
    CREATE TABLE IF NOT EXISTS ad_images(
      id BIGSERIAL PRIMARY KEY,
      ad_id UUID,
      url TEXT,
      ord INT DEFAULT 0
    )
  `).catch(()=>{});

  await q(`
    ALTER TABLE ads
    ADD COLUMN IF NOT EXISTS user_id TEXT,
    ADD COLUMN IF NOT EXISTS featured BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ
  `).catch(()=>{});
}

/* ================= Upload ================= */

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOADS_DIR),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + '-' + Math.round(Math.random()*1e9) + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 1024 * 2 }
});

/* ================= Pages ================= */

app.get('/', (_, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/categories', (_, res) => res.sendFile(path.join(PUBLIC_DIR, 'categories.html')));
app.get('/login', (_, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
app.get('/register', (_, res) => res.sendFile(path.join(PUBLIC_DIR, 'register.html')));
app.get('/admin', (_, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));

/* ================= PUBLIC ADS ================= */

app.get('/api/ads', async (_, res) => {
  try {
    const r = await q(`
      SELECT 
        a.*,
        (
          SELECT url
          FROM ad_images
          WHERE ad_id = a.id
          ORDER BY ord ASC
          LIMIT 1
        ) as image
      FROM ads a
      WHERE a.status='published'
      ORDER BY a.created_at DESC
      LIMIT 20
    `);
    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

app.get('/api/ads/featured', async (_, res) => {
  try {
    const r = await q(`
      SELECT 
        a.*,
        (
          SELECT url
          FROM ad_images
          WHERE ad_id = a.id
          ORDER BY ord ASC
          LIMIT 1
        ) as image
      FROM ads a
      WHERE a.status='published'
        AND a.featured=true
      ORDER BY a.created_at DESC
      LIMIT 10
    `);
    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

/* ================= AUTH ================= */

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  const r = await q(
    `SELECT id,password,is_admin FROM users WHERE lower(email)=lower($1) LIMIT 1`,
    [email]
  );

  const u = r.rows[0];
  if (!u) return res.status(401).json({ error: 'INVALID' });

  const ok = await bcrypt.compare(password, u.password);
  if (!ok) return res.status(401).json({ error: 'INVALID' });

  req.session.user = { id: u.id, is_admin: !!u.is_admin };
  res.json({ ok: true });
});

/* ================= CREATE AD ================= */

app.post('/api/ads',
  upload.fields([{ name:'images', maxCount:6 }]),
  async (req, res) => {
    try {
      if (!req.session.user) return res.status(401).json({ error:'UNAUTHORIZED' });

      const { title, description, price, city, category } = req.body;

      const adRes = await q(`
        INSERT INTO ads (id,user_id,title,description,price,city,category,status,featured)
        VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,'published',false)
        RETURNING id
      `,[req.session.user.id,title,description,price,city,category]);

      const adId = adRes.rows[0].id;

      const images = req.files?.images || [];
      for (let i=0;i<images.length;i++) {
        await q(
          `INSERT INTO ad_images (ad_id,url,ord) VALUES ($1,$2,$3)`,
          [adId, '/uploads/'+images[i].filename, i]
        );
      }

      res.json({ ok:true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error:'SERVER_ERROR' });
    }
  }
);

/* ================= ADMIN ROUTES ================= */

app.use('/api/admin', adminRoutes);

/* ================= START ================= */

async function start() {
  try {
    await ensureDb();
    app.listen(PORT, () => {
      console.log(`✅ Server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Startup failed:', err);
    process.exit(1);
  }
}

start();