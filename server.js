const express = require("express");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const multer = require("multer");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

/* ---------------------- PostgreSQL Connection ---------------------- */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ---------------------- Initialize Database ---------------------- */
async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT,
      email TEXT UNIQUE,
      password TEXT,
      phone TEXT,
      city TEXT,
      bio TEXT,
      avatar TEXT,
      disabled BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads (
      id TEXT PRIMARY KEY,
      ref TEXT,
      title TEXT,
      description TEXT,
      price NUMERIC,
      city TEXT,
      category TEXT,
      images TEXT[],
      video TEXT,
      owner_name TEXT,
      owner_email TEXT,
      owner_phone TEXT,
      featured BOOLEAN DEFAULT FALSE,
      status TEXT DEFAULT 'pending',
      views INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      data JSONB
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS stats (
      id INTEGER PRIMARY KEY DEFAULT 1,
      views INTEGER DEFAULT 0
    );
  `);

  await pool.query(`INSERT INTO settings (id, data) VALUES (1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING;`);
  await pool.query(`INSERT INTO stats (id, views) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;`);

  console.log("✅ Database initialized successfully");
}

/* ---------------------- Middleware ---------------------- */
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ extended: true, limit: "100mb" }));

/* ---------------------- Upload Setup ---------------------- */
const UPLOADS_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOADS_DIR),
  filename: (_, file, cb) => {
    const safeName = file.originalname.replace(/\s+/g, "-");
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${safeName}`);
  }
});

const upload = multer({ storage, limits: { fileSize: 1100 * 1024 * 1024 } });
const fileUrl = (filename) => `/uploads/${filename}`;

/* ---------------------- Cookie Helpers ---------------------- */
function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  return Object.fromEntries(header.split(";").map(c => {
    const [k, v] = c.trim().split("=");
    return [k, decodeURIComponent(v)];
  }));
}

function isAuthenticated(req) {
  return parseCookies(req).auth === "1";
}

function isAdmin(req) {
  return parseCookies(req).isAdmin === "1";
}

async function getCurrentUser(req) {
  const cookies = parseCookies(req);
  if (!cookies.userId) return null;
  const result = await pool.query("SELECT * FROM users WHERE id=$1", [cookies.userId]);
  return result.rows[0] || null;
}

app.use(async (req, res, next) => {
  req.isAuthenticated = isAuthenticated(req);
  req.currentUser = await getCurrentUser(req);
  next();
});

/* ---------------------- Auth Routes ---------------------- */
app.post("/api/auth/register", async (req, res) => {
  const { name, email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: "خاص الايميل وكلمة السر" });

  const exists = await pool.query("SELECT id FROM users WHERE email=$1", [email]);
  if (exists.rows.length) return res.status(400).json({ message: "الإيميل مسجل من قبل" });

  const id = Date.now().toString();
  await pool.query(`INSERT INTO users (id, name, email, password) VALUES ($1,$2,$3,$4)`,
    [id, name || "", email, password]);

  res.cookie("auth", "1", { httpOnly: true, sameSite: "Lax", path: "/" });
  res.cookie("userId", id, { httpOnly: true, sameSite: "Lax", path: "/" });

  res.json({ message: "تم إنشاء الحساب بنجاح" });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  const ADMIN_EMAIL = "GG";
  const ADMIN_PASSWORD = "simo@simo1999";

  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    res.cookie("auth", "1", { httpOnly: true, sameSite: "Lax", path: "/" });
    res.cookie("isAdmin", "1", { httpOnly: true, sameSite: "Lax", path: "/" });
    return res.json({ message: "مرحبا أدمن", isAdmin: true });
  }

  const result = await pool.query("SELECT * FROM users WHERE email=$1", [email]);
  const user = result.rows[0];
  if (!user || user.password !== password) {
    return res.status(401).json({ message: "الإيميل أو كلمة السر خاطئة" });
  }

  res.cookie("auth", "1", { httpOnly: true, sameSite: "Lax", path: "/" });
  res.cookie("userId", user.id, { httpOnly: true, sameSite: "Lax", path: "/" });

  res.json({ message: "تم تسجيل الدخول بنجاح" });
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("auth", { path: "/" });
  res.clearCookie("userId", { path: "/" });
  res.clearCookie("isAdmin", { path: "/" });
  res.json({ message: "تم تسجيل الخروج" });
});

app.get("/api/auth/me", async (req, res) => {
  if (!req.isAuthenticated || !req.currentUser) {
    return res.status(401).json({ message: "مستخدم غير مسجل" });
  }
  const { id, name, email, phone, city, bio, avatar } = req.currentUser;
  res.json({ id, name, email, phone, city, bio, avatar });
});

/* ---------------------- Ads Routes ---------------------- */
function generateRef() {
  const t = Date.now().toString();
  return `REF-${t.slice(-6)}-${Math.floor(Math.random() * 900 + 100)}`;
}

app.post("/api/ads", upload.fields([{ name: "images", maxCount: 3 }, { name: "video", maxCount: 1 }]), async (req, res) => {
  if (!req.isAuthenticated) return res.status(401).json({ message: "خاصك تكون مسجل" });

  const { title, description, price, city, category, ownerName, ownerEmail, ownerPhone } = req.body;
  if (!title || !description || !price || !city || !category) {
    return res.status(400).json({ message: "عمر جميع الخانات المطلوبة" });
  }

  const images = (req.files?.images || []).map(f => fileUrl(f.filename));
  if (!images.length) return res.status(400).json({ message: "صورة واحدة على الأقل ضرورية" });

  const video = req.files?.video?.[0] ? fileUrl(req.files.video[0].filename) : "";

  const id = Date.now().toString();
  const ref = generateRef();

  await pool.query(
    `INSERT INTO ads (id, ref, title, description, price, city, category, images, video, owner_name, owner_email, owner_phone)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, ref, title, description, Number(price), city, category, images, video,
      ownerName || req.currentUser.name,
      ownerEmail || req.currentUser.email,
      ownerPhone || ""]
  );

  res.status(201).json({ message: "تم إرسال الإعلان للمراجعة", ad: { id, ref, title, images } });
});

app.get("/api/ads", async (req, res) => {
  const result = await pool.query("SELECT * FROM ads WHERE status='approved' ORDER BY created_at DESC");
  const ads = result.rows.map(ad => {
    const pub = { ...ad, image: ad.images?.[0] || "" };
    if (!req.isAuthenticated) {
      delete pub.owner_phone;
      delete pub.owner_email;
    }
    return pub;
  });
  res.json(ads);
});

/* ---------------------- Admin Routes ---------------------- */
app.patch("/api/admin/ads/:id/approve", async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ message: "غير مصرح" });
  await pool.query("UPDATE ads SET status='approved' WHERE id=$1 OR ref=$1", [req.params.id]);
  res.json({ message: "تم قبول الإعلان" });
});

app.patch("/api/admin/ads/:id/reject", async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ message: "غير مصرح" });
  await pool.query("UPDATE ads SET status='rejected' WHERE id=$1 OR ref=$1", [req.params.id]);
  res.json({ message: "تم رفض الإعلان" });
});

/* ---------------------- Settings ---------------------- */
app.get("/api/settings", async (req, res) => {
  const result = await pool.query("SELECT data FROM settings WHERE id=1");
  res.json(result.rows[0]?.data || {});
});

app.put("/api/settings", upload.any(), async (req, res) => {
  const current = (await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data || {};
  const updated = { ...current, ...req.body };
  await pool.query("UPDATE settings SET data=$1 WHERE id=1", [updated]);
  res.json({ message: "تم حفظ الإعدادات", settings: updated });
});

/* ---------------------- Static Files ---------------------- */
app.use("/uploads", express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  const file = path.join(__dirname, "public", req.path === "/" ? "index.html" : `${req.path}.html`);
  if (fs.existsSync(file)) return res.sendFile(file);
  res.status(404).send("الصفحة غير موجودة");
});

/* ---------------------- Error Handler ---------------------- */
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: err.message || "خطأ في السيرفر" });
});

/* ---------------------- Start Server ---------------------- */
initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  })
  .catch(err => console.error("❌ Database initialization error:", err));