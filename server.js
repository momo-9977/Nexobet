// server.js (محدّث لدعم Postgres مع fallback لملفات JSON كما في الإصدار الأصلي)
const express = require("express");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const multer = require("multer");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const UPLOADS_DIR = path.join(ROOT_DIR, "uploads");
const DATA_DIR = path.join(ROOT_DIR, "data");

const ADS_FILE = path.join(DATA_DIR, "ads.json");
const PROFILE_FILE = path.join(DATA_DIR, "profile.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const STATS_FILE = path.join(DATA_DIR, "stats.json");
const USERS_FILE = path.join(DATA_DIR, "users.json");

/* ----------------------- Postgres setup (KV store) ----------------------- */
/**
 * نهج بسيط: نستخدم جدول kvstore(key TEXT PRIMARY KEY, value JSONB) لتخزين
 * المستندات الكاملة: ads, users, settings, profile, stats
 *
 * - عند التشغيل: نحاول مزامنة DB مع الملفات المحلية (أو العكس) بحيث يعمل السيرفر
 *   كما قبل لكن بياناتك تُخزن أيضاً في Postgres إن أعددت DATABASE_URL.
 * - writeJson سيقوم بعمل upsert على جدول kvstore غير متزامن (background).
 */

const DATABASE_URL = process.env.DATABASE_URL || process.env.PG_CONNECTION || null;
let pool = null;

if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    // Railway and some hosts require ssl with rejectUnauthorized false
    ssl: {
      rejectUnauthorized: false
    }
  });

  pool.on("error", (err) => {
    console.error("Postgres pool error:", err);
  });
}

async function ensureKVTable() {
  if (!pool) return;
  const createSQL = `
    CREATE TABLE IF NOT EXISTS kvstore (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL
    );
  `;
  await pool.query(createSQL);
}

async function kvGet(key) {
  if (!pool) return null;
  const r = await pool.query("SELECT value FROM kvstore WHERE key=$1", [key]);
  if (r.rows.length === 0) return null;
  return r.rows[0].value;
}

async function kvSet(key, value) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO kvstore(key, value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value]
    );
  } catch (e) {
    console.error("kvSet error:", e);
  }
}

/* ---------------------- file helpers (existing behaviour) ---------------------- */

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function ensureFile(filePath, defaultValue) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2), "utf8");
  }
}

function readJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    return fallback;
  }
}

function writeJson(filePath, data) {
  // write to disk synchronously (preserve original behavior)
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    console.error("writeJson file write error:", e);
  }

  // if DB is configured, also persist asynchronously into kvstore
  if (pool) {
    // map filePath to a stable key name
    let key = null;
    if (path.resolve(filePath) === path.resolve(ADS_FILE)) key = "ads";
    else if (path.resolve(filePath) === path.resolve(USERS_FILE)) key = "users";
    else if (path.resolve(filePath) === path.resolve(SETTINGS_FILE)) key = "settings";
    else if (path.resolve(filePath) === path.resolve(PROFILE_FILE)) key = "profile";
    else if (path.resolve(filePath) === path.resolve(STATS_FILE)) key = "stats";

    if (key) {
      // do not await, run in background
      kvSet(key, data).catch(err => {
        console.error("Failed to kvSet:", err);
      });
    }
  }
}

/* ---------------------- ensure directories + files ---------------------- */

ensureDir(PUBLIC_DIR);
ensureDir(UPLOADS_DIR);
ensureDir(DATA_DIR);

ensureFile(ADS_FILE, []);
ensureFile(PROFILE_FILE, {
  name: "",
  email: "",
  phone: "",
  city: "",
  bio: "",
  verified: false,
  avatar: "",
  password: ""
});
ensureFile(USERS_FILE, []);
ensureFile(SETTINGS_FILE, {
  platformName: "سمسار",
  platformSubtitle: "بيع وشراء بسهولة",
  logo: "",
  bannerTitle: "لقى كلشي فسمسار",
  bannerDescription: "بيع وشراء بسهولة وبأمان",
  bannerImages: [],
  support: {
    whatsapp: "",
    email: "",
    telegram: ""
  },
  categories: {
    phones: {
      name: "الهواتف",
      description: "هواتف جديدة ومستعملة",
      image: ""
    },
    cars: {
      name: "السيارات",
      description: "سيارات اقتصادية وعائلية وفاخرة",
      image: ""
    },
    homes: {
      name: "العقارات",
      description: "شقق ومنازل وأراضي ومحلات",
      image: ""
    },
    furniture: {
      name: "الأثاث",
      description: "أثاث منزلي ومكتبي",
      image: ""
    }
  }
});

ensureFile(STATS_FILE, {
  views: 0
});

/* ---------------------- إذا كان هناك قاعدة بيانات، نزامنها مع الملفات ---------------------- */
async function syncDbAndFilesOnStartup() {
  if (!pool) return;

  try {
    await ensureKVTable();

    // keys to synchronize
    const pairs = [
      { key: "ads", file: ADS_FILE, defaultValue: readJson(ADS_FILE, []) },
      { key: "users", file: USERS_FILE, defaultValue: readJson(USERS_FILE, []) },
      { key: "settings", file: SETTINGS_FILE, defaultValue: readJson(SETTINGS_FILE, {}) },
      { key: "profile", file: PROFILE_FILE, defaultValue: readJson(PROFILE_FILE, {}) },
      { key: "stats", file: STATS_FILE, defaultValue: readJson(STATS_FILE, { views: 0 }) }
    ];

    for (const p of pairs) {
      const dbVal = await kvGet(p.key);
      if (dbVal !== null && dbVal !== undefined) {
        // DB has data → overwrite local file with DB (so app uses DB state)
        try {
          fs.writeFileSync(p.file, JSON.stringify(dbVal, null, 2), "utf8");
        } catch (e) {
          console.error("Error writing file from DB sync:", p.file, e);
        }
      } else {
        // DB empty for this key → write current local file content to DB
        try {
          const local = p.defaultValue;
          await kvSet(p.key, local);
        } catch (e) {
          console.error("Error writing local data to DB kv:", e);
        }
      }
    }

    console.log("Postgres KV sync completed.");
  } catch (e) {
    console.error("Error during DB <-> file sync:", e);
  }
}

/* ---------------------- MIDDLEWARE ---------------------- */
app.use(
  cors({
    origin: true,
    credentials: true
  })
);

app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ extended: true, limit: "100mb" }));

/* ---------------------- Multer setup (كما في الأصل) ---------------------- */
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOADS_DIR);
  },
  filename: function (req, file, cb) {
    const safeName = file.originalname.replace(/\s+/g, "-");
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}-${safeName}`;
    cb(null, uniqueName);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedImageTypes = [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/jpg"
  ];
  const allowedVideoTypes = [
    "video/mp4",
    "video/webm",
    "video/ogg",
    "video/quicktime"
  ];

  if (
    allowedImageTypes.includes(file.mimetype) ||
    allowedVideoTypes.includes(file.mimetype)
  ) {
    cb(null, true);
  } else {
    cb(new Error("نوع الملف غير مدعوم"));
  }
};

// set global fileSize to 1.1GB to allow large uploads (we'll still validate per-field later)
const MAX_GLOBAL_BYTES = 1100 * 1024 * 1024;

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_GLOBAL_BYTES
  }
});

/* ---------------------- توابع مساعدة ---------------------- */

function fileUrl(filename) {
  return `/uploads/${filename}`;
}

function buildPublicAd(ad) {
  return {
    ...ad,
    image: ad.images && ad.images.length > 0 ? ad.images[0] : ""
  };
}

function generateRef() {
  const t = Date.now().toString();
  const tail = t.slice(-6);
  const rnd = Math.floor(Math.random() * 900) + 100; // 3 digits
  return `REF-${tail}-${rnd}`;
}

/* users helpers */
function readUsers() {
  return readJson(USERS_FILE, []);
}
function writeUsers(u) {
  writeJson(USERS_FILE, u);
}
function findUserByEmail(email) {
  if (!email) return null;
  const users = readUsers();
  return users.find(u => u.email && u.email.toLowerCase() === email.toLowerCase()) || null;
}
function findUserById(id) {
  if (!id) return null;
  const users = readUsers();
  return users.find(u => u.id === id) || null;
}

/* ---------------------- auth helpers ---------------------- */
function parseCookies(req) {
  const header = req.headers && req.headers.cookie;
  if (!header) return {};
  return header.split(";").map(c => c.trim()).reduce((acc, pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return acc;
    const key = pair.slice(0, idx);
    const val = pair.slice(idx + 1);
    acc[key] = decodeURIComponent(val);
    return acc;
  }, {});
}

function isAuthenticatedReq(req) {
  const cookies = parseCookies(req);
  return cookies.auth === "1" || cookies.auth === "true";
}

function currentUserFromReq(req) {
  const cookies = parseCookies(req);
  const userId = cookies.userId;
  return userId ? findUserById(userId) : null;
}

app.use((req, res, next) => {
  req.isAuthenticated = isAuthenticatedReq(req);
  req.currentUser = currentUserFromReq(req);
  next();
});

/* ---------------------- Auth: register / login / logout ---------------------- */

app.post("/api/auth/register", (req, res) => {
  const { name, email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ message: "خاص الايميل وكلمة السر" });
  }

  if (findUserByEmail(email)) {
    return res.status(400).json({ message: "الإيميل مسجل من قبل" });
  }

  const users = readUsers();
  const user = {
    id: `${Date.now()}`,
    name: name || "",
    email,
    password,
    phone: "",
    city: "",
    bio: "",
    avatar: ""
  };
  users.push(user);
  writeUsers(users);

  res.cookie("auth", "1", { httpOnly: true, sameSite: "Lax", maxAge: 7 * 24 * 3600 * 1000, path: "/" });
  res.cookie("userId", user.id, { httpOnly: true, sameSite: "Lax", maxAge: 7 * 24 * 3600 * 1000, path: "/" });

  res.json({ message: "تم التحقق من البيانات بنجاح", user: { id: user.id, name: user.name, email: user.email } });
});

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ message: "خاص الايميل وكلمة السر" });
  }

  const ADMIN_EMAIL = "GG";
  const ADMIN_PASSWORD = "simo@simo1999";

  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    res.cookie("auth", "1", { httpOnly: true, sameSite: "Lax", path: "/" });
    res.cookie("isAdmin", "1", { httpOnly: true, sameSite: "Lax", path: "/" });

    return res.json({
      message: "مرحبا أدمن",
      isAdmin: true
    });
  }

  const user = findUserByEmail(email);
  if (!user || user.password !== password) {
    return res.status(401).json({ message: "الإيميل أو كلمة السر خاطئة" });
  }

  res.cookie("auth", "1", { httpOnly: true, sameSite: "Lax", path: "/" });
  res.cookie("userId", user.id, { httpOnly: true, sameSite: "Lax", path: "/" });

  res.json({
    message: "تم التحقق من البيانات بنجاح",
    isAdmin: false
  });
});

// logout endpoint (clears cookies)
app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("auth", { path: "/" });
  res.clearCookie("userId", { path: "/" });
  res.clearCookie("isAdmin", { path: "/" });
  res.json({ message: "تم تسجيل الخروج" });
});

app.get("/api/auth/me", (req, res) => {
  if (!req.isAuthenticated) return res.status(401).json({ message: "مستخدم غير مسجل" });
  const u = req.currentUser;
  if (!u) return res.status(401).json({ message: "مستخدم غير موجود" });
  res.json({
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone || "",
    city: u.city || "",
    bio: u.bio || "",
    avatar: u.avatar || ""
  });
});

app.patch("/api/auth/password", (req, res) => {
  if (!req.isAuthenticated) return res.status(401).json({ message: "مستخدم غير مصادق" });
  const u = req.currentUser;
  if (!u) return res.status(401).json({ message: "مستخدم غير موجود" });

  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ message: "كلمة السر خاصها تكون 6 أحرف على الأقل" });
  }

  if (currentPassword && u.password !== currentPassword) {
    return res.status(401).json({ message: "كلمة السر الحالية خاطئة" });
  }

  const users = readUsers();
  const idx = users.findIndex(x => x.id === u.id);
  if (idx === -1) return res.status(404).json({ message: "المستخدم غير موجود" });

  users[idx].password = newPassword;
  writeUsers(users);

  res.json({ message: "تم تغيير كلمة السر" });
});

/* ---------------------- Routes for pages without extension (same as original) ---------------------- */

app.get(/^\/.*\.html$/i, (req, res) => {
  const p = req.path || "";
  const noext = p.replace(/\.html$/i, "") || "/";
  res.redirect(301, noext);
});

const alwaysOpen = new Set(["/login", "/register", "/support", "/ad"]);

function isAdminReq(req) {
  const cookies = parseCookies(req);
  return cookies.isAdmin === "1";
}

app.get(
  ["/", "/profile", "/post-ad", "/admin", "/categories", "/register", "/login", "/support", "/ad", "/edit-ad"],
  (req, res) => {
    const reqPath = req.path || "";

    if (reqPath === "/") {
      return res.sendFile(path.join(PUBLIC_DIR, "index.html"));
    }

    if (reqPath === "/admin") {
      const cookies = parseCookies(req);
      if (cookies.isAdmin !== "1") {
        return res.redirect("/login");
      }
      const candidate = path.join(PUBLIC_DIR, "admin.html");
      if (fs.existsSync(candidate)) return res.sendFile(candidate);
      return res.status(404).send("الصفحة غير موجودة");
    }

    if (alwaysOpen.has(reqPath)) {
      // /ad should be accessible without login (ad detail)
      const filename = reqPath.replace(/^\//, "") || "index";
      const candidate = path.join(PUBLIC_DIR, `${filename}.html`);
      if (fs.existsSync(candidate)) return res.sendFile(candidate);
      return res.status(404).send("الصفحة غير موجودة");
    }

    if (!req.isAuthenticated) {
      return res.redirect("/login");
    }

    const candidate = path.join(PUBLIC_DIR, `${reqPath.replace(/^\//, "")}.html`);
    if (fs.existsSync(candidate)) {
      return res.sendFile(candidate);
    }

    return res.status(404).send("الصفحة غير موجودة");
  }
);

/* static files */
app.use("/uploads", express.static(UPLOADS_DIR));
app.use(express.static(PUBLIC_DIR));

app.get("/index", (req, res) => res.redirect(301, "/"));

/* ----------------------------- API settings (compatibility) ----------------------------- */

app.get("/api/settings", (req, res) => {
  const settings = readJson(SETTINGS_FILE, {});
  res.json(settings);
});

// expose admin-friendly alias endpoints for admin panel compatibility
app.get("/api/admin/settings", (req, res) => {
  if (!req.isAuthenticated) return res.status(401).json({ message: "مستخدم غير مصادق" });
  const settings = readJson(SETTINGS_FILE, {});
  res.json(settings);
});

app.put("/api/settings", upload.fields([
  { name: "logo", maxCount: 1 },
  { name: "bannerImages", maxCount: 10 },
  { name: "catPhonesImage", maxCount: 1 },
  { name: "catCarsImage", maxCount: 1 },
  { name: "catHomesImage", maxCount: 1 },
  { name: "catFurnitureImage", maxCount: 1 }
]), (req, res) => {
  // existing implementation preserved
  const current = readJson(SETTINGS_FILE, {
    platformName: "سمسار",
    platformSubtitle: "بيع وشراء بسهولة",
    logo: "",
    bannerTitle: "لقى كلشي فسمسار",
    bannerDescription: "بيع وشراء بسهولة وبأمان",
    bannerImages: [],
    support: { whatsapp: "", email: "", telegram: "" },
    categories: {
      phones: { name: "الهواتف", description: "هواتف جديدة ومستعملة", image: "" },
      cars: { name: "السيارات", description: "سيارات اقتصادية وعائلية وفاخرة", image: "" },
      homes: { name: "العقارات", description: "شقق ومنازل وأراضي ومحلات", image: "" },
      furniture: { name: "الأثاث", description: "أثاث منزلي ومكتبي", image: "" }
    }
  });

  const files = req.files || {};
  const logoFile = files.logo?.[0] || null;
  const bannerImagesFiles = files.bannerImages || [];

  let nextBannerImages = Array.isArray(current.bannerImages) ? current.bannerImages.slice() : [];

  if (req.body.resetBannerImages === "true") {
    nextBannerImages = [];
  }

  if (bannerImagesFiles.length > 0) {
    const added = bannerImagesFiles.map((file) => fileUrl(file.filename));
    nextBannerImages = nextBannerImages.concat(added).slice(0, 20);
  }

  const updated = {
    ...current,
    platformName: req.body.platformName || current.platformName,
    platformSubtitle: req.body.platformSubtitle || current.platformSubtitle,
    bannerTitle: req.body.bannerTitle || current.bannerTitle,
    bannerDescription: req.body.bannerDescription || current.bannerDescription,
    logo: logoFile ? fileUrl(logoFile.filename) : current.logo,
    bannerImages: nextBannerImages,
    support: {
      whatsapp: req.body.supportWhatsapp ?? current.support?.whatsapp ?? "",
      email: req.body.supportEmail ?? current.support?.email ?? "",
      telegram: req.body.supportTelegram ?? current.support?.telegram ?? ""
    },
    categories: {
      phones: {
        name: req.body.catPhonesName || current.categories?.phones?.name || "الهواتف",
        description: req.body.catPhonesDesc || current.categories?.phones?.description || "هواتف جديدة ومستعملة",
        image: files.catPhonesImage?.[0]
          ? fileUrl(files.catPhonesImage[0].filename)
          : current.categories?.phones?.image || ""
      },
      cars: {
        name: req.body.catCarsName || current.categories?.cars?.name || "السيارات",
        description: req.body.catCarsDesc || current.categories?.cars?.description || "سيارات اقتصادية وعائلية وفاخرة",
        image: files.catCarsImage?.[0]
          ? fileUrl(files.catCarsImage[0].filename)
          : current.categories?.cars?.image || ""
      },
      homes: {
        name: req.body.catHomesName || current.categories?.homes?.name || "العقارات",
        description: req.body.catHomesDesc || current.categories?.homes?.description || "شقق ومنازل وأراضي ومحلات",
        image: files.catHomesImage?.[0]
          ? fileUrl(files.catHomesImage[0].filename)
          : current.categories?.homes?.image || ""
      },
      furniture: {
        name: req.body.catFurnitureName || current.categories?.furniture?.name || "الأثاث",
        description: req.body.catFurnitureDesc || current.categories?.furniture?.description || "أثاث منزلي ومكتبي",
        image: files.catFurnitureImage?.[0]
          ? fileUrl(files.catFurnitureImage[0].filename)
          : current.categories?.furniture?.image || ""
      }
    }
  };

  writeJson(SETTINGS_FILE, updated);
  res.json({
    message: "تم حفظ إعدادات المنصة",
    settings: updated
  });
});

// admin-friendly contacts endpoints (compatibility with admin panel)
app.get("/api/admin/contacts", (req, res) => {
  if (!req.isAuthenticated) return res.status(401).json({ message: "مستخدم غير مصادق" });
  const settings = readJson(SETTINGS_FILE, {});
  res.json(settings.support || {});
});
app.put("/api/admin/contacts", (req, res) => {
  if (!req.isAuthenticated) return res.status(401).json({ message: "مستخدم غير مصادق" });
  const settings = readJson(SETTINGS_FILE, {});
  settings.support = {
    whatsapp: req.body.whatsapp ?? req.body.supportWhatsapp ?? settings.support?.whatsapp ?? "",
    email: req.body.email ?? req.body.supportEmail ?? settings.support?.email ?? "",
    telegram: req.body.telegram ?? req.body.supportTelegram ?? settings.support?.telegram ?? ""
  };
  writeJson(SETTINGS_FILE, settings);
  res.json({ message: "تم حفظ القنوات", support: settings.support });
});

/* ----------------------------- banners endpoints compatible with admin panel ----------------------------- */

app.get("/api/admin/banners", (req, res) => {
  if (!req.isAuthenticated) return res.status(401).json({ message: "مستخدم غير مصادق" });
  const settings = readJson(SETTINGS_FILE, {});
  const arr = Array.isArray(settings.bannerImages) ? settings.bannerImages : [];
  const list = arr.map((url, idx) => ({ id: String(idx), url }));
  res.json(list);
});

app.post("/api/admin/banners", upload.array("images", 20), (req, res) => {
  if (!req.isAuthenticated) return res.status(401).json({ message: "مستخدم غير مصادق" });
  const settings = readJson(SETTINGS_FILE, {});
  let arr = Array.isArray(settings.bannerImages) ? settings.bannerImages.slice() : [];
  const files = req.files || [];

  if (files.length === 0) {
    // try single file 'image' field (multer may provide under different name)
    return res.status(400).json({ message: "لم يتم إرسال أي صورة" });
  }

  const added = files.map(f => fileUrl(f.filename));
  arr = arr.concat(added).slice(0, 20);
  settings.bannerImages = arr;
  writeJson(SETTINGS_FILE, settings);

  res.json({ message: "تم رفع البانرات", banners: settings.bannerImages });
});

app.delete("/api/admin/banners/:index", (req, res) => {
  if (!req.isAuthenticated) return res.status(401).json({ message: "مستخدم غير مصادق" });
  const idx = Number(req.params.index);
  const settings = readJson(SETTINGS_FILE, {});
  if (!Array.isArray(settings.bannerImages)) settings.bannerImages = [];
  if (Number.isNaN(idx) || idx < 0 || idx >= settings.bannerImages.length) {
    return res.status(404).json({ message: "لم يتم العثور على البانر" });
  }
  settings.bannerImages.splice(idx, 1);
  writeJson(SETTINGS_FILE, settings);
  res.json({ message: "تم حذف البانر", banners: settings.bannerImages });
});

app.put("/api/admin/banners/:index/set-main", (req, res) => {
  if (!req.isAuthenticated) return res.status(401).json({ message: "مستخدم غير مصادق" });
  const idx = Number(req.params.index);
  const settings = readJson(SETTINGS_FILE, {});
  let arr = Array.isArray(settings.bannerImages) ? settings.bannerImages.slice() : [];
  if (Number.isNaN(idx) || idx < 0 || idx >= arr.length) {
    return res.status(404).json({ message: "لم يتم العثور على البانر" });
  }
  const [item] = arr.splice(idx, 1);
  arr.unshift(item); // make it first
  settings.bannerImages = arr;
  writeJson(SETTINGS_FILE, settings);
  res.json({ message: "تم تعيين البانر كأول بانر", banners: settings.bannerImages });
});

/* ----------------------------- compat banner endpoints ----------------------------- */
app.put("/api/admin/banner", upload.array("images", 20), (req, res) => {
  if (!req.isAuthenticated) return res.status(401).json({ message: "مستخدم غير مصادق" });

  const settings = readJson(SETTINGS_FILE, {});
  let arr = Array.isArray(settings.bannerImages) ? settings.bannerImages.slice() : [];
  const files = req.files || [];

  if (req.body.resetBannerImages === "true") {
    arr = [];
  }

  if (files.length > 0) {
    const added = files.map(f => fileUrl(f.filename));
    arr = arr.concat(added).slice(0, 20);
  }

  settings.bannerImages = arr;
  if (req.body.bannerTitle) settings.bannerTitle = req.body.bannerTitle;
  if (req.body.bannerDesc) settings.bannerDescription = req.body.bannerDesc;

  writeJson(SETTINGS_FILE, settings);
  res.json({ message: "تم تحديث بانرات المنصة (compat)", banners: settings.bannerImages, bannerTitle: settings.bannerTitle, bannerDescription: settings.bannerDescription });
});

app.delete("/api/settings/banner-images/:index", (req, res) => {
  if (!req.isAuthenticated) return res.status(401).json({ message: "مستخدم غير مصادق" });
  const idx = Number(req.params.index);
  const settings = readJson(SETTINGS_FILE, {});
  if (!Array.isArray(settings.bannerImages)) settings.bannerImages = [];
  if (Number.isNaN(idx) || idx < 0 || idx >= settings.bannerImages.length) {
    return res.status(404).json({ message: "لم يتم العثور على صورة البانر" });
  }
  settings.bannerImages.splice(idx, 1);
  writeJson(SETTINGS_FILE, settings);
  res.json({ message: "تم حذف صورة البانر", banners: settings.bannerImages });
});

/* ----------------------------- API البروفايل (منصة عامة) ----------------------------- */
app.get("/api/profile", (req, res) => {
  const profile = readJson(PROFILE_FILE, {});
  res.json(profile);
});

/* ----------------------------- API المستخدمين ----------------------------- */

app.get("/api/users", (req, res) => {
  if (!req.isAuthenticated) return res.status(401).json({ message: "مستخدم غير مصادق" });
  const users = readUsers().map(u => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, city: u.city }));
  res.json(users);
});

app.get("/api/users/:id", (req, res) => {
  if (!req.isAuthenticated) return res.status(401).json({ message: "مستخدم غير مصادق" });
  const user = findUserById(req.params.id);
  if (!user) return res.status(404).json({ message: "المستخدم غير موجود" });
  res.json({
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone || "",
    city: user.city || "",
    bio: user.bio || "",
    avatar: user.avatar || ""
  });
});

app.put("/api/users/:id", (req, res) => {
  if (!req.isAuthenticated) return res.status(401).json({ message: "مستخدم غير مصادق" });
  const me = req.currentUser;
  if (!me) return res.status(401).json({ message: "مستخدم غير موجود" });

  if (me.id !== req.params.id) {
    return res.status(403).json({ message: "غير مصرح لك بتعديل هذا الحساب" });
  }

  const users = readUsers();
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ message: "المستخدم غير موجود" });

  const allowed = ["name", "phone", "city", "bio", "email"];
  for (const k of allowed) {
    if (req.body[k] !== undefined) {
      users[idx][k] = req.body[k];
    }
  }

  writeUsers(users);
  const updated = users[idx];
  res.json({ message: "تم حفظ بيانات المستخدم", user: { id: updated.id, name: updated.name, email: updated.email, phone: updated.phone, city: updated.city, bio: updated.bio, avatar: updated.avatar } });
});

/* avatar upload */
app.put("/api/users/:id/avatar", upload.single("avatar"), (req, res) => {
  if (!req.isAuthenticated) return res.status(401).json({ message: "مستخدم غير مصادق" });
  const me = req.currentUser;
  if (!me) return res.status(401).json({ message: "مستخدم غير موجود" });

  if (me.id !== req.params.id) {
    return res.status(403).json({ message: "غير مصرح لك بتعديل هذا الحساب" });
  }

  if (!req.file) {
    return res.status(400).json({ message: "لم يتم إرسال صورة" });
  }

  // check image size (client requested 10MB max)
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  if (req.file.size > MAX_IMAGE_BYTES) {
    // delete uploaded file
    try { fs.unlinkSync(path.join(UPLOADS_DIR, req.file.filename)); } catch (e) {}
    return res.status(400).json({ message: "حجم الصورة أكبر من 10 ميغابايت" });
  }

  const users = readUsers();
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ message: "المستخدم غير موجود" });

  users[idx].avatar = fileUrl(req.file.filename);
  writeUsers(users);

  res.json({ message: "تم رفع الافاتار", avatar: users[idx].avatar });
});

/* ----------------------------- API الإعلانات ----------------------------- */

app.get("/api/ads", (req, res) => {
  const ads = readJson(ADS_FILE, []);
  const approvedAds = ads.filter((ad) => ad.status === "approved");
  const publicAds = approvedAds.map(ad => {
    const pub = buildPublicAd(ad);
    if (!req.isAuthenticated) {
      delete pub.ownerPhone;
      delete pub.ownerEmail;
    }
    return pub;
  });
  res.json(publicAds);
});

app.get("/api/ads/featured", (req, res) => {
  const ads = readJson(ADS_FILE, []);
  const featuredAds = ads
    .filter((ad) => ad.status === "approved" && ad.featured)
    .map(ad => {
      const pub = buildPublicAd(ad);
      if (!req.isAuthenticated) {
        delete pub.ownerPhone;
        delete pub.ownerEmail;
      }
      return pub;
    });

  res.json(featuredAds);
});

app.get("/api/ads/:id", (req, res) => {
  const ads = readJson(ADS_FILE, []);
  const ad = ads.find((item) => item.id === req.params.id || item.ref === req.params.id);

  if (!ad) {
    return res.status(404).json({ message: "الإعلان غير موجود" });
  }

  if (ad.status !== "approved") {
    return res.status(403).json({ message: "هذا الإعلان لم يتم قبوله بعد" });
  }

  const stats = readJson(STATS_FILE, { views: 0 });
  stats.views = (stats.views || 0) + 1;
  writeJson(STATS_FILE, stats);

  ad.views = (ad.views || 0) + 1;
  const adsAll = readJson(ADS_FILE, []);
  const idx = adsAll.findIndex(a => a.id === ad.id);
  if (idx !== -1) {
    adsAll[idx] = ad;
    writeJson(ADS_FILE, adsAll);
  }

  const out = { ...ad };
  if (!req.isAuthenticated) {
    delete out.ownerPhone;
    delete out.ownerEmail;
  }

  res.json(out);
});

/**
 * POST /api/ads
 * - requires authentication
 * - enforces: images >=1, each image <= 10MB, video <= 1GB (server-side check)
 */
app.post(
  "/api/ads",
  upload.fields([
    { name: "images", maxCount: 3 },
    { name: "video", maxCount: 1 }
  ]),
  (req, res) => {
    if (!req.isAuthenticated) {
      return res.status(401).json({ message: "خاصك تكون مسجل باش تنشر إعلان" });
    }

    const {
      title,
      description,
      price,
      city,
      category,
      ownerName,
      ownerEmail,
      ownerPhone
    } = req.body;

    const imageFiles = req.files?.images || [];
    const videoFile = req.files?.video?.[0];

    // validate required fields
    if (!title || !description || !price || !city || !category) {
      // delete uploaded files to avoid garbage
      (req.files && Object.values(req.files).flat()).forEach(f => {
        try { fs.unlinkSync(path.join(UPLOADS_DIR, f.filename)); } catch (e) {}
      });
      return res.status(400).json({ message: "عمر جميع الخانات المطلوبة" });
    }

    if (imageFiles.length === 0) {
      (req.files && Object.values(req.files).flat()).forEach(f => {
        try { fs.unlinkSync(path.join(UPLOADS_DIR, f.filename)); } catch (e) {}
      });
      return res.status(400).json({ message: "صورة واحدة على الأقل ضرورية" });
    }

    // server-side size checks
    const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB
    const MAX_VIDEO_BYTES = 1024 * 1024 * 1024; // 1GB

    for (const img of imageFiles) {
      if (img.size > MAX_IMAGE_BYTES) {
        // clean up all uploaded
        (req.files && Object.values(req.files).flat()).forEach(f => {
          try { fs.unlinkSync(path.join(UPLOADS_DIR, f.filename)); } catch (e) {}
        });
        return res.status(400).json({ message: "حجم إحدى الصور أكبر من 10 ميغابايت" });
      }
    }

    if (videoFile && videoFile.size > MAX_VIDEO_BYTES) {
      (req.files && Object.values(req.files).flat()).forEach(f => {
        try { fs.unlinkSync(path.join(UPLOADS_DIR, f.filename)); } catch (e) {}
      });
      return res.status(400).json({ message: "حجم الفيديو أكبر من 1 جيجابايت" });
    }

    const ads = readJson(ADS_FILE, []);

    const newAd = {
      id: `${Date.now()}`,
      ref: generateRef(),
      title,
      description,
      price: Number(price),
      city,
      category,
      images: imageFiles.map((file) => fileUrl(file.filename)),
      video: videoFile ? fileUrl(videoFile.filename) : "",
      ownerName: ownerName || (req.currentUser ? req.currentUser.name : ""),
      ownerEmail: ownerEmail || (req.currentUser ? req.currentUser.email : ""),
      ownerPhone: ownerPhone || "",
      featured: false,
      status: "pending",
      views: 0,
      createdAt: new Date().toISOString()
    };

    ads.unshift(newAd);
    writeJson(ADS_FILE, ads);

    res.status(201).json({
      message: "تم إرسال الإعلان للمراجعة وسيظهر بعد موافقة الأدمن",
      ad: buildPublicAd(newAd)
    });
  }
);

app.put(
  "/api/ads/:id",
  upload.fields([
    { name: "images", maxCount: 3 },
    { name: "video", maxCount: 1 }
  ]),
  (req, res) => {
    const ads = readJson(ADS_FILE, []);
    const adIndex = ads.findIndex((item) => item.id === req.params.id || item.ref === req.params.id);

    if (adIndex === -1) {
      return res.status(404).json({ message: "الإعلان غير موجود" });
    }

    const current = ads[adIndex];
    const imageFiles = req.files?.images || [];
    const videoFile = req.files?.video?.[0];

    // server-side size checks (if files present)
    const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB
    const MAX_VIDEO_BYTES = 1024 * 1024 * 1024; // 1GB
    for (const img of imageFiles) {
      if (img.size > MAX_IMAGE_BYTES) {
        (req.files && Object.values(req.files).flat()).forEach(f => {
          try { fs.unlinkSync(path.join(UPLOADS_DIR, f.filename)); } catch (e) {}
        });
        return res.status(400).json({ message: "حجم إحدى الصور أكبر من 10 ميغابايت" });
      }
    }
    if (videoFile && videoFile.size > MAX_VIDEO_BYTES) {
      (req.files && Object.values(req.files).flat()).forEach(f => {
        try { fs.unlinkSync(path.join(UPLOADS_DIR, f.filename)); } catch (e) {}
      });
      return res.status(400).json({ message: "حجم الفيديو أكبر من 1 جيجابايت" });
    }

    const updated = {
      ...current,
      title: req.body.title ?? current.title,
      description: req.body.description ?? current.description,
      price: req.body.price ? Number(req.body.price) : current.price,
      city: req.body.city ?? current.city,
      category: req.body.category ?? current.category,
      ownerName: req.body.ownerName ?? current.ownerName,
      ownerEmail: req.body.ownerEmail ?? current.ownerEmail,
      ownerPhone: req.body.ownerPhone ?? current.ownerPhone,
      featured:
        req.body.featured !== undefined
          ? req.body.featured === "true" || req.body.featured === true
          : current.featured,
      status: req.body.status ?? current.status,
      images: imageFiles.length > 0
        ? imageFiles.map((file) => fileUrl(file.filename))
        : current.images,
      video: videoFile ? fileUrl(videoFile.filename) : current.video
    };

    ads[adIndex] = updated;
    writeJson(ADS_FILE, ads);

    res.json({ message: "تم تعديل الإعلان", ad: updated });
  }
);

app.delete("/api/ads/:id", (req, res) => {
  const ads = readJson(ADS_FILE, []);
  const filteredAds = ads.filter((item) => item.id !== req.params.id && item.ref !== req.params.id);

  if (filteredAds.length === ads.length) {
    return res.status(404).json({ message: "الإعلان غير موجود" });
  }

  writeJson(ADS_FILE, filteredAds);
  res.json({ message: "تم حذف الإعلان" });
});

app.patch("/api/ads/:id/featured", (req, res) => {
  const ads = readJson(ADS_FILE, []);
  const ad = ads.find((item) => item.id === req.params.id || item.ref === req.params.id);

  if (!ad) {
    return res.status(404).json({ message: "الإعلان غير موجود" });
  }

  ad.featured = !ad.featured;
  writeJson(ADS_FILE, ads);

  res.json({
    message: ad.featured ? "تم تمييز الإعلان" : "تم إلغاء تمييز الإعلان",
    ad
  });
});

/* ----------------------------- API خاص بالمستخدم: إعلاناتي ----------------------------- */

app.get("/api/my/ads", (req, res) => {
  if (!req.isAuthenticated) return res.status(401).json({ message: "غير مصادق" });
  const u = req.currentUser;
  if (!u) return res.status(401).json({ message: "المستخدم غير موجود" });

  const ads = readJson(ADS_FILE, []);
  const mine = ads.filter(ad => {
    const ownerEmail = (ad.ownerEmail || "").toLowerCase();
    const ownerName = (ad.ownerName || "").toLowerCase();
    return (u.email && ownerEmail === u.email.toLowerCase()) || (u.name && ownerName === u.name.toLowerCase());
  });

  res.json(mine);
});

/* ----------------------------- API الأدمن ----------------------------- */

app.get("/api/admin/init", (req, res) => {
  if (!req.isAuthenticated) return res.status(401).json({ message: "مستخدم غير مصادق" });
  const ads = readJson(ADS_FILE, []);
  const profile = readJson(PROFILE_FILE, {});
  const stats = readJson(STATS_FILE, { views: 0 });
  const settings = readJson(SETTINGS_FILE, {});
  const users = readUsers();

  res.json({
    platform: {
      name: settings.platformName || "",
      subtitle: settings.platformSubtitle || "",
      logo: settings.logo || ""
    },
    banner: {
      title: settings.bannerTitle || "",
      desc: settings.bannerDescription || "",
      images: Array.isArray(settings.bannerImages) ? settings.bannerImages : []
    },
    categories: settings.categories || {},
    support: settings.support || {},
    ads: ads,
    users: users,
    profile,
    stats
  });
});

app.get("/api/admin/dashboard", (req, res) => {
  if (!req.isAuthenticated) return res.status(401).json({ message: "مستخدم غير مصادق" });
  const ads = readJson(ADS_FILE, []);
  const profile = readJson(PROFILE_FILE, {});
  const stats = readJson(STATS_FILE, { views: 0 });
  const settings = readJson(SETTINGS_FILE, {});

  res.json({
    stats: {
      adsCount: ads.length,
      pendingCount: ads.filter((ad) => ad.status === "pending").length,
      approvedCount: ads.filter((ad) => ad.status === "approved").length,
      rejectedCount: ads.filter((ad) => ad.status === "rejected").length,
      featuredCount: ads.filter((ad) => ad.featured).length,
      verifiedCount: profile.verified ? 1 : 0,
      viewsCount: stats.views || 0
    },
    settings,
    profile,
    ads
  });
});

app.get("/api/admin/ads", (req, res) => {
  if (!req.isAuthenticated) return res.status(401).json({ message: "مستخدم غير مصادق" });
  const ads = readJson(ADS_FILE, []);
  const q = (req.query.search || "").toString().trim().toLowerCase();

  if (!q) {
    return res.json(ads);
  }

  const filtered = ads.filter(ad => {
    return (
      (ad.ref && ad.ref.toLowerCase().includes(q)) ||
      (ad.id && ad.id.toLowerCase().includes(q)) ||
      (ad.title && ad.title.toLowerCase().includes(q)) ||
      (ad.ownerPhone && ad.ownerPhone.toLowerCase().includes(q))
    );
  });

  res.json(filtered);
});

app.get("/api/admin/ads/pending", (req, res) => {
  if (!req.isAuthenticated) return res.status(401).json({ message: "مستخدم غير مصادق" });
  const ads = readJson(ADS_FILE, []);
  res.json(ads.filter((ad) => ad.status === "pending"));
});

app.patch("/api/admin/ads/:id/approve", (req, res) => {
  if (!req.isAuthenticated) return res.status(401).json({ message: "مستخدم غير مصادق" });
  const ads = readJson(ADS_FILE, []);
  const ad = ads.find((item) => item.id === req.params.id || item.ref === req.params.id);

  if (!ad) {
    return res.status(404).json({ message: "الإعلان غير موجود" });
  }

  ad.status = "approved";
  writeJson(ADS_FILE, ads);

  res.json({ message: "تم قبول الإعلان", ad });
});

app.patch("/api/admin/ads/:id/reject", (req, res) => {
  if (!req.isAuthenticated) return res.status(401).json({ message: "مستخدم غير مصادق" });
  const ads = readJson(ADS_FILE, []);
  const ad = ads.find((item) => item.id === req.params.id || item.ref === req.params.id);

  if (!ad) {
    return res.status(404).json({ message: "الإعلان غير موجود" });
  }

  ad.status = "rejected";
  writeJson(ADS_FILE, ads);

  res.json({ message: "تم رفض الإعلان", ad });
});

app.post("/api/ads/:id/status", (req, res) => {
  if (!req.isAuthenticated) return res.status(401).json({ message: "خاص الحالة" });

  const status = req.body && req.body.status;
  if (!status) return res.status(400).json({ message: "خاص الحالة" });

  const ads = readJson(ADS_FILE, []);
  const idx = ads.findIndex(a => a.id === req.params.id || a.ref === req.params.id);
  if (idx === -1) return res.status(404).json({ message: "الإعلان غير موجود" });

  ads[idx].status = status;
  writeJson(ADS_FILE, ads);
  res.json({ message: "تم تحديث حالة الإعلان", ad: ads[idx] });
});

/* admin platform/categories endpoints were implemented earlier */

/* admin helpers */
app.put("/api/admin/platform", upload.single("logo"), (req, res) => {
  if (!req.isAuthenticated) return res.status(401).json({ message: "مستخدم غير مصادق" });

  const settings = readJson(SETTINGS_FILE, {});
  const name = req.body.name ?? req.body.platformName ?? settings.platformName;
  const subtitle = req.body.subtitle ?? req.body.platformSubtitle ?? settings.platformSubtitle;
  const logoFile = req.file;

  const updated = {
    ...settings,
    platformName: name,
    platformSubtitle: subtitle,
    logo: logoFile ? fileUrl(logoFile.filename) : settings.logo
  };

  writeJson(SETTINGS_FILE, updated);
  res.json({ message: "تم حفظ إعدادات المنصة", platform: { name: updated.platformName, subtitle: updated.platformSubtitle, logo: updated.logo } });
});

app.put("/api/admin/categories", upload.fields([
  { name: "cat_phones", maxCount: 1 },
  { name: "cat_cars", maxCount: 1 },
  { name: "cat_homes", maxCount: 1 },
  { name: "cat_furniture", maxCount: 1 },
  { name: "catPhonesImage", maxCount: 1 },
  { name: "catCarsImage", maxCount: 1 },
  { name: "catHomesImage", maxCount: 1 },
  { name: "catFurnitureImage", maxCount: 1 }
]), (req, res) => {
  if (!req.isAuthenticated) return res.status(401).json({ message: "مستخدم غير مصادق" });

  const current = readJson(SETTINGS_FILE, {});
  let categories = current.categories || {};

  if (req.body.categories) {
    try {
      const parsed = typeof req.body.categories === "string" ? JSON.parse(req.body.categories) : req.body.categories;
      categories = { ...categories, ...parsed };
    } catch (e) {}
  }

  const files = req.files || {};
  const getFileUrlIfPresent = (names) => {
    for (const n of names) {
      if (files[n] && files[n][0]) return fileUrl(files[n][0].filename);
    }
    return null;
  };

  categories.phones = categories.phones || {};
  categories.cars = categories.cars || {};
  categories.homes = categories.homes || {};
  categories.furniture = categories.furniture || {};

  const pImg = getFileUrlIfPresent(["cat_phones", "catPhonesImage"]);
  if (pImg) categories.phones.image = pImg;
  const cImg = getFileUrlIfPresent(["cat_cars", "catCarsImage"]);
  if (cImg) categories.cars.image = cImg;
  const hImg = getFileUrlIfPresent(["cat_homes", "catHomesImage"]);
  if (hImg) categories.homes.image = hImg;
  const fImg = getFileUrlIfPresent(["cat_furniture", "catFurnitureImage"]);
  if (fImg) categories.furniture.image = fImg;

  const updated = {
    ...current,
    categories
  };

  writeJson(SETTINGS_FILE, updated);
  res.json({ message: "تم حفظ إعدادات الأقسام", categories: updated.categories });
});

app.put("/api/admin/support", (req, res) => {
  if (!req.isAuthenticated) return res.status(401).json({ message: "مستخدم غير مصادق" });
  const settings = readJson(SETTINGS_FILE, {});
  const support = {
    whatsapp: req.body.whatsapp ?? req.body.supportWhatsapp ?? settings.support?.whatsapp ?? "",
    email: req.body.email ?? req.body.supportEmail ?? settings.support?.email ?? "",
    telegram: req.body.telegram ?? req.body.supportTelegram ?? settings.support?.telegram ?? ""
  };
  const updated = { ...settings, support };
  writeJson(SETTINGS_FILE, updated);
  res.json({ message: "تم حفظ إعدادات الدعم", support: updated.support });
});

app.patch("/api/admin/profile/verify", (req, res) => {
  if (!req.isAuthenticated) return res.status(401).json({ message: "مستخدم غير مصادق" });
  const { verified } = req.body;
  const profile = readJson(PROFILE_FILE, {});

  profile.verified = verified === true || verified === "true";
  writeJson(PROFILE_FILE, profile);

  res.json({ message: "تم تحديث حالة التوثيق", profile });
});

app.delete("/api/admin/ads", (req, res) => {
  if (!req.isAuthenticated) return res.status(401).json({ message: "مستخدم غير مصادق" });
  writeJson(ADS_FILE, []);
  res.json({ message: "تم حذف جميع الإعلانات" });
});

app.patch("/api/admin/views/reset", (req, res) => {
  if (!req.isAuthenticated) return res.status(401).json({ message: "مستخدم غير مصادق" });
  writeJson(STATS_FILE, { views: 0 });
  res.json({ message: "تم تصفير المشاهدات" });
});

/* Admin users management endpoints (ADDED) */
app.get("/api/admin/users", (req, res) => {
  if (!req.isAuthenticated) return res.status(401).json({ message: "مستخدم غير مصادق" });
  const users = readUsers();
  res.json(users.map(u => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, city: u.city, disabled: u.disabled || false })));
});

app.put("/api/admin/users/:id", (req, res) => {
  if (!req.isAuthenticated) return res.status(401).json({ message: "مستخدم غير مصادق" });
  const users = readUsers();
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ message: "المستخدم غير موجود" });

  // allow admin to update common fields
  const allowed = ["name", "email", "phone", "city", "bio", "avatar", "disabled"];
  for (const k of allowed) {
    if (req.body[k] !== undefined) users[idx][k] = req.body[k];
  }

  writeUsers(users);
  res.json({ message: "تم تعديل بيانات المستخدم", user: users[idx] });
});

app.delete("/api/admin/users/:id", (req, res) => {
  if (!req.isAuthenticated) return res.status(401).json({ message: "مستخدم غير مصادق" });
  const users = readUsers();
  const filtered = users.filter(u => u.id !== req.params.id);
  if (filtered.length === users.length) return res.status(404).json({ message: "المستخدم غير موجود" });
  writeUsers(filtered);
  res.json({ message: "تم حذف المستخدم" });
});

app.post("/api/admin/users/:id/password", (req, res) => {
  if (!req.isAuthenticated) return res.status(401).json({ message: "مستخدم غير مصادق" });
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ message: "كلمة السر خاصها تكون 6 أحرف على الأقل" });

  const users = readUsers();
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ message: "المستخدم غير موجود" });

  users[idx].password = newPassword;
  writeUsers(users);
  res.json({ message: "تم تعيين كلمة السر الجديدة للمستخدم" });
});

/* ----------------------------- أخطاء ----------------------------- */

app.use((err, req, res, next) => {
  console.error(err);

  if (err instanceof multer.MulterError) {
    return res.status(400).json({ message: `خطأ في رفع الملفات: ${err.message}` });
  }

  res.status(500).json({
    message: err.message || "وقع خطأ داخلي في السيرفر"
  });
});

/* ----------------------------- تشغيل السيرفر (مع المزامنة إلى DB عند الحاجة) ----------------------------- */

(async function start() {
  try {
    if (pool) {
      console.log("Postgres detected -- syncing with local JSON files...");
      await syncDbAndFilesOnStartup();
    }
  } catch (e) {
    console.error("Startup DB sync error:", e);
  }

  app.listen(PORT, () => {
    console.log(`Server khdam f http://localhost:${PORT}`);
  });
})();