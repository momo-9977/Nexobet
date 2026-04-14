// server.js
const express = require("express");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const multer = require("multer");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "change_this_secret";
const JWT_EXPIRES_IN = "7d";

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const UPLOADS_DIR = path.join(ROOT_DIR, "uploads");
const DATA_DIR = path.join(ROOT_DIR, "data");

const ADS_FILE = path.join(DATA_DIR, "ads.json");
const PROFILE_FILE = path.join(DATA_DIR, "profile.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const STATS_FILE = path.join(DATA_DIR, "stats.json");
const USERS_FILE = path.join(DATA_DIR, "users.json");

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
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

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

// users: ملف يحتوي على المستخدمين مع كلمة سر مشفرة ووسم isAdmin
if (!fs.existsSync(USERS_FILE)) {
  // ننشئ مستخدم أدمن افتراضي (غير آمن للاستعمال في الإنتاج — غيّر الباسوورد)
  const adminPasswordHash = bcrypt.hashSync("admin123", 10);
  ensureFile(USERS_FILE, [
    {
      id: "u-admin",
      name: "Admin",
      email: "admin@example.com",
      phone: "",
      isAdmin: true,
      passwordHash: adminPasswordHash,
      createdAt: new Date().toISOString()
    }
  ]);
}

app.use(cors());
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ extended: true, limit: "100mb" }));

/* ---------------------- إعداد multer ---------------------- */
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

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024
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

// توليد رقم مرجعي قصير وقرائي
function generateRef() {
  const t = Date.now().toString();
  const tail = t.slice(-6);
  const rnd = Math.floor(Math.random() * 900) + 100; // 3 digits
  return `REF-${tail}-${rnd}`;
}

/* ---------------------- مصادقة JWT ---------------------- */

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, isAdmin: !!user.isAdmin, name: user.name },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function authenticateJWT(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ message: "مطلوب تسجيل الدخول" });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    return next();
  } catch (err) {
    return res.status(401).json({ message: "رمز المصادقة غير صالح" });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ message: "مطلوب تسجيل الدخول" });
  if (!req.user.isAdmin) return res.status(403).json({ message: "مطلوب صلاحيات الأدمن" });
  return next();
}

/* ---------------------- منع ظهور .html و serve صفحات بدون امتداد ---------------------- */

/**
 * إذا جاء طلب إلى something.html نوجهه إلى /something (301)
 * هذا يضمن أن المستخدم لا يرى .html في شريط العنوان
 */
app.get("/*.html", (req, res, next) => {
  const p = req.path;
  const noext = p.replace(/\.html$/i, "");
  res.redirect(301, noext || "/");
});

/**
 * Serve صفحات من مجلد public مع التعامل مع المسارات بدون امتداد
 * فقط إذا الملف موجود نرسله، وإلا نمرر للتحكم التالي (مثلاً ملفات static أو 404)
 */
app.get(["/", "/profile", "/post-ad", "/admin", "/categories", "/register", "/login", "/support"], (req, res, next) => {
  let reqPath = req.path;
  if (reqPath === "/") {
    return res.sendFile(path.join(PUBLIC_DIR, "index.html"));
  }
  // امنع الاصطدام مع الـ API أو الـ uploads
  if (reqPath.startsWith("/api") || reqPath.startsWith("/uploads")) return next();

  const candidate = path.join(PUBLIC_DIR, `${reqPath.replace(/^\//, "")}.html`);
  if (fs.existsSync(candidate)) {
    return res.sendFile(candidate);
  } else {
    return res.status(404).send("الصفحة غير موجودة");
  }
});

/* ملفات الستاتيك (css, js, images, uploads) */
app.use("/uploads", express.static(UPLOADS_DIR));
app.use(express.static(PUBLIC_DIR));

/* ----------------------------- صفحات HTML احتياطية ----------------------------- */

app.get("/index", (req, res) => res.redirect(301, "/"));

/* ----------------------------- API: Auth (Register / Login) ----------------------------- */

/**
 * تسجيل مستخدم جديد
 * body: { name, email, password, phone }
 * يجيب توكن JWT عند النجاح
 */
app.post("/api/auth/register", async (req, res) => {
  const { name, email, password, phone } = req.body;
  if (!email || !password || !name) {
    return res.status(400).json({ message: "الاسم، الإيميل و كلمة السر مطلوبة" });
  }

  const users = readJson(USERS_FILE, []);
  const exists = users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (exists) {
    return res.status(400).json({ message: "هذا البريد مستعمل من قبل" });
  }

  const hash = await bcrypt.hash(password, 10);
  const newUser = {
    id: `u-${Date.now()}`,
    name,
    email,
    phone: phone || "",
    isAdmin: false,
    passwordHash: hash,
    createdAt: new Date().toISOString()
  };

  users.unshift(newUser);
  writeJson(USERS_FILE, users);

  const token = signToken(newUser);
  res.status(201).json({ message: "تم التسجيل", token, user: { id: newUser.id, name: newUser.name, email: newUser.email, phone: newUser.phone } });
});

/**
 * تسجيل دخول مستخدم
 * body: { email, password }
 * يرجع JWT عند النجاح
 */
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: "الإيميل و كلمة السر مطلوبين" });

  const users = readJson(USERS_FILE, []);
  const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (!user) return res.status(401).json({ message: "بيانات الدخول غير صحيحة" });

  const ok = await bcrypt.compare(password, user.passwordHash || "");
  if (!ok) return res.status(401).json({ message: "بيانات الدخول غير صحيحة" });

  const token = signToken(user);
  res.json({ message: "تم تسجيل الدخول", token, user: { id: user.id, name: user.name, email: user.email, phone: user.phone, isAdmin: user.isAdmin } });
});

/**
 * احصل على بيانات المستخدم الحالي (يتطلب Authorization: Bearer <token>)
 */
app.get("/api/me", authenticateJWT, (req, res) => {
  const users = readJson(USERS_FILE, []);
  const user = users.find(u => u.id === req.user.id || u.email === req.user.email);
  if (!user) return res.status(404).json({ message: "المستخدم غير موجود" });
  res.json({ id: user.id, name: user.name, email: user.email, phone: user.phone, isAdmin: user.isAdmin });
});

/* ----------------------------- API الإعدادات ----------------------------- */

app.get("/api/settings", (req, res) => {
  const settings = readJson(SETTINGS_FILE, {});
  res.json(settings);
});

app.put(
  "/api/settings",
  authenticateJWT,
  requireAdmin,
  upload.fields([
    { name: "logo", maxCount: 1 },
    { name: "bannerImages", maxCount: 10 },
    { name: "catPhonesImage", maxCount: 1 },
    { name: "catCarsImage", maxCount: 1 },
    { name: "catHomesImage", maxCount: 1 },
    { name: "catFurnitureImage", maxCount: 1 }
  ]),
  (req, res) => {
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

    // إذا طلبت إعادة تعيين الصور (reset) نمسح الكل
    if (req.body.resetBannerImages === "true") {
      nextBannerImages = [];
    }

    // نضيف الصور الجديدة إلى القائمة بدلاً من استبدالها
    if (bannerImagesFiles.length > 0) {
      const added = bannerImagesFiles.map((file) => fileUrl(file.filename));
      nextBannerImages = nextBannerImages.concat(added).slice(0, 20); // حد أقصى احتياطي
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
  }
);

app.delete("/api/settings/banner-images/:index", authenticateJWT, requireAdmin, (req, res) => {
  const settings = readJson(SETTINGS_FILE, {});
  const index = Number(req.params.index);

  if (!Array.isArray(settings.bannerImages)) {
    settings.bannerImages = [];
  }

  if (Number.isNaN(index) || index < 0 || index >= settings.bannerImages.length) {
    return res.status(404).json({ message: "الصورة غير موجودة" });
  }

  settings.bannerImages.splice(index, 1);
  writeJson(SETTINGS_FILE, settings);

  res.json({
    message: "تم حذف صورة البانر",
    settings
  });
});

/* ----------------------------- API البروفايل ----------------------------- */

app.get("/api/profile", (req, res) => {
  const profile = readJson(PROFILE_FILE, {});
  res.json(profile);
});

app.put("/api/profile", authenticateJWT, upload.single("avatar"), (req, res) => {
  const current = readJson(PROFILE_FILE, {
    name: "",
    email: "",
    phone: "",
    city: "",
    bio: "",
    verified: false,
    avatar: "",
    password: ""
  });

  const updated = {
    ...current,
    name: req.body.name ?? current.name,
    email: req.body.email ?? current.email,
    phone: req.body.phone ?? current.phone,
    city: req.body.city ?? current.city,
    bio: req.body.bio ?? current.bio,
    verified:
      req.body.verified !== undefined
        ? req.body.verified === "true" || req.body.verified === true
        : current.verified,
    avatar: req.file ? fileUrl(req.file.filename) : current.avatar
  };

  writeJson(PROFILE_FILE, updated);
  res.json({ message: "تم حفظ البروفايل", profile: updated });
});

app.put("/api/profile/password", authenticateJWT, (req, res) => {
  const { newPassword } = req.body;

  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ message: "كلمة السر خاصها تكون 6 أحرف على الأقل" });
  }

  // إذا أردت تغيير كلمة سر الأدمن أو المستخدم، حدث في users.json
  const users = readJson(USERS_FILE, []);
  const userIdx = users.findIndex(u => u.id === req.user.id);
  if (userIdx === -1) return res.status(404).json({ message: "المستخدم غير موجود" });

  users[userIdx].passwordHash = bcrypt.hashSync(newPassword, 10);
  writeJson(USERS_FILE, users);

  res.json({ message: "تم تغيير كلمة السر" });
});

/* ----------------------------- API الإعلانات ----------------------------- */

app.get("/api/ads", (req, res) => {
  const ads = readJson(ADS_FILE, []);
  const approvedAds = ads.filter((ad) => ad.status === "approved");
  const publicAds = approvedAds.map(buildPublicAd);
  res.json(publicAds);
});

app.get("/api/ads/featured", (req, res) => {
  const ads = readJson(ADS_FILE, []);
  const featuredAds = ads
    .filter((ad) => ad.status === "approved" && ad.featured)
    .map(buildPublicAd);

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

  res.json(ad);
});

app.post(
  "/api/ads",
  upload.fields([
    { name: "images", maxCount: 3 },
    { name: "video", maxCount: 1 }
  ]),
  (req, res) => {
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

    if (!title || !description || !price || !city || !category) {
      return res.status(400).json({ message: "عمر جميع الخانات المطلوبة" });
    }

    if (imageFiles.length === 0) {
      return res.status(400).json({ message: "صورة واحدة على الأقل ضرورية" });
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
      ownerName: ownerName || "",
      ownerEmail: ownerEmail || "",
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

app.delete("/api/ads/:id", authenticateJWT, requireAdmin, (req, res) => {
  const ads = readJson(ADS_FILE, []);
  const filteredAds = ads.filter((item) => item.id !== req.params.id && item.ref !== req.params.id);

  if (filteredAds.length === ads.length) {
    return res.status(404).json({ message: "الإعلان غير موجود" });
  }

  writeJson(ADS_FILE, filteredAds);
  res.json({ message: "تم حذف الإعلان" });
});

app.patch("/api/ads/:id/featured", authenticateJWT, requireAdmin, (req, res) => {
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

/* ----------------------------- API الأدمن ----------------------------- */

app.get("/api/admin/dashboard", authenticateJWT, requireAdmin, (req, res) => {
  const ads = readJson(ADS_FILE, []);
  const profile = readJson(PROFILE_FILE, {});
  const stats = readJson(STATS_FILE, { views: 0 });
  const settings = readJson(SETTINGS_FILE, {});
  const users = readJson(USERS_FILE, []);

  res.json({
    stats: {
      adsCount: ads.length,
      pendingCount: ads.filter((ad) => ad.status === "pending").length,
      approvedCount: ads.filter((ad) => ad.status === "approved").length,
      rejectedCount: ads.filter((ad) => ad.status === "rejected").length,
      featuredCount: ads.filter((ad) => ad.featured).length,
      verifiedCount: profile.verified ? 1 : 0,
      viewsCount: stats.views || 0,
      usersCount: users.length
    },
    settings,
    profile,
    ads
  });
});

/**
 * GET /api/admin/ads
 * optional query:
 *  - search=...  => يبحث في ref, id, title, ownerPhone (case-insensitive)
 */
app.get("/api/admin/ads", authenticateJWT, requireAdmin, (req, res) => {
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

app.get("/api/admin/ads/pending", authenticateJWT, requireAdmin, (req, res) => {
  const ads = readJson(ADS_FILE, []);
  res.json(ads.filter((ad) => ad.status === "pending"));
});

app.patch("/api/admin/ads/:id/approve", authenticateJWT, requireAdmin, (req, res) => {
  const ads = readJson(ADS_FILE, []);
  const ad = ads.find((item) => item.id === req.params.id || item.ref === req.params.id);

  if (!ad) {
    return res.status(404).json({ message: "الإعلان غير موجود" });
  }

  ad.status = "approved";
  writeJson(ADS_FILE, ads);

  res.json({ message: "تم قبول الإعلان", ad });
});

app.patch("/api/admin/ads/:id/reject", authenticateJWT, requireAdmin, (req, res) => {
  const ads = readJson(ADS_FILE, []);
  const ad = ads.find((item) => item.id === req.params.id || item.ref === req.params.id);

  if (!ad) {
    return res.status(404).json({ message: "الإعلان غير موجود" });
  }

  ad.status = "rejected";
  writeJson(ADS_FILE, ads);

  res.json({ message: "تم رفض الإعلان", ad });
});

app.patch("/api/admin/profile/verify", authenticateJWT, requireAdmin, (req, res) => {
  const { verified } = req.body;
  const profile = readJson(PROFILE_FILE, {});

  profile.verified = verified === true || verified === "true";
  writeJson(PROFILE_FILE, profile);

  res.json({ message: "تم تحديث حالة التوثيق", profile });
});

app.delete("/api/admin/ads", authenticateJWT, requireAdmin, (req, res) => {
  writeJson(ADS_FILE, []);
  res.json({ message: "تم حذف جميع الإعلانات" });
});

app.patch("/api/admin/views/reset", authenticateJWT, requireAdmin, (req, res) => {
  writeJson(STATS_FILE, { views: 0 });
  res.json({ message: "تم تصفير المشاهدات" });
});

/* ----------------------------- Users management (admin) ----------------------------- */

/**
 * GET /api/admin/users
 * optional: ?search=...
 */
app.get("/api/admin/users", authenticateJWT, requireAdmin, (req, res) => {
  const users = readJson(USERS_FILE, []);
  const q = (req.query.search || "").toString().trim().toLowerCase();
  if (!q) return res.json(users.map(u => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, isAdmin: u.isAdmin, createdAt: u.createdAt })));

  const filtered = users.filter(u => {
    return (
      (u.email && u.email.toLowerCase().includes(q)) ||
      (u.name && u.name.toLowerCase().includes(q)) ||
      (u.phone && u.phone.toLowerCase().includes(q)) ||
      (u.id && u.id.toLowerCase().includes(q))
    );
  }).map(u => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, isAdmin: u.isAdmin, createdAt: u.createdAt }));

  res.json(filtered);
});

app.get("/api/admin/users/:id", authenticateJWT, requireAdmin, (req, res) => {
  const users = readJson(USERS_FILE, []);
  const u = users.find(x => x.id === req.params.id || x.email === req.params.id);
  if (!u) return res.status(404).json({ message: "المستخدم غير موجود" });
  res.json({ id: u.id, name: u.name, email: u.email, phone: u.phone, isAdmin: u.isAdmin, createdAt: u.createdAt });
});

app.patch("/api/admin/users/:id", authenticateJWT, requireAdmin, (req, res) => {
  const users = readJson(USERS_FILE, []);
  const idx = users.findIndex(x => x.id === req.params.id || x.email === req.params.id);
  if (idx === -1) return res.status(404).json({ message: "المستخدم غير موجود" });

  const u = users[idx];
  u.name = req.body.name ?? u.name;
  u.phone = req.body.phone ?? u.phone;
  if (req.body.isAdmin !== undefined) u.isAdmin = !!req.body.isAdmin;
  // لتغيير كلمة السر: send { password: "newpass" }
  if (req.body.password) {
    u.passwordHash = bcrypt.hashSync(req.body.password, 10);
  }

  users[idx] = u;
  writeJson(USERS_FILE, users);
  res.json({ message: "تم تعديل المستخدم", user: { id: u.id, name: u.name, email: u.email, phone: u.phone, isAdmin: u.isAdmin } });
});

app.delete("/api/admin/users/:id", authenticateJWT, requireAdmin, (req, res) => {
  const users = readJson(USERS_FILE, []);
  const filtered = users.filter(x => x.id !== req.params.id && x.email !== req.params.id);
  if (filtered.length === users.length) return res.status(404).json({ message: "المستخدم غير موجود" });
  writeJson(USERS_FILE, filtered);
  res.json({ message: "تم حذف المستخدم" });
});

/* ----------------------------- أخطاء ----------------------------- */

app.use((err, req, res, next) => {
  console.error(err);

  if (err instanceof multer.MulterError) {
    return res.status(400).json({ message: `خطأ فرفع الملفات: ${err.message}` });
  }

  res.status(500).json({
    message: err.message || "وقع خطأ داخلي في السيرفر"
  });
});

/* ----------------------------- تشغيل السيرفر ----------------------------- */

app.listen(PORT, () => {
  console.log(`Server khdam f http://localhost:${PORT}`);
});