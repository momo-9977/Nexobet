const express = require("express");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const multer = require("multer");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

/* ---------------- DATABASE ---------------- */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ---------------- INIT TABLES ---------------- */

async function initDatabase(){

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
  is_admin BOOLEAN DEFAULT FALSE,
  disabled BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`);

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
  owner_id TEXT,
  owner_name TEXT,
  owner_email TEXT,
  owner_phone TEXT,
  featured BOOLEAN DEFAULT FALSE,
  status TEXT DEFAULT 'pending',
  views INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`);

}

/* ---------------- MIDDLEWARE ---------------- */

app.use(cors({ origin:true, credentials:true }));
app.use(express.json());
app.use(express.urlencoded({extended:true}));

/* ---------------- UPLOAD ---------------- */

const UPLOADS = path.join(__dirname,"uploads");
if(!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS);

const storage = multer.diskStorage({
destination: (_,__,cb)=>cb(null,UPLOADS),
filename: (_,file,cb)=>cb(null,Date.now()+"-"+file.originalname)
});

const upload = multer({storage});

/* ---------------- COOKIES ---------------- */

function parseCookies(req){
const header=req.headers.cookie;
if(!header) return {};
return Object.fromEntries(header.split(";").map(c=>{
const [k,v]=c.trim().split("=");
return [k,decodeURIComponent(v)];
}));
}

function isAuth(req){ return parseCookies(req).auth==="1"; }
function getUserId(req){ return parseCookies(req).userId; }

async function isAdmin(req){
  if(!isAuth(req)) return false;
  const id = getUserId(req);
  const r = await pool.query("SELECT is_admin FROM users WHERE id=$1",[id]);
  return r.rows.length && r.rows[0].is_admin === true;
}

/* ---------------- AUTH ---------------- */

app.post("/api/auth/register", async(req,res)=>{
const {name,email,password,phone}=req.body;
const id=Date.now().toString();

await pool.query(
"INSERT INTO users(id,name,email,password,phone) VALUES($1,$2,$3,$4,$5)",
[id,name,email,password,phone]
);

res.cookie("auth","1",{httpOnly:true,path:"/"});
res.cookie("userId",id,{httpOnly:true,path:"/"});
res.json({message:"تم التسجيل"});
});

app.post("/api/auth/login", async(req,res)=>{
const {email,password}=req.body;
const r=await pool.query("SELECT * FROM users WHERE email=$1",[email]);
if(!r.rows.length) return res.status(401).json({message:"خطأ"});

const user=r.rows[0];
if(user.password!==password) return res.status(401).json({message:"خطأ"});
if(user.disabled) return res.status(403).json({message:"الحساب معطل"});

res.cookie("auth","1",{httpOnly:true,path:"/"});
res.cookie("userId",user.id,{httpOnly:true,path:"/"});
res.json({message:"تم الدخول", isAdmin:user.is_admin});
});

/* ---------------- ADMIN DASHBOARD ---------------- */

app.get("/api/admin/init", async(req,res)=>{
if(!(await isAdmin(req))) return res.status(401).json({});

const totalAds = await pool.query("SELECT COUNT(*) FROM ads");
const totalUsers = await pool.query("SELECT COUNT(*) FROM users");
const pendingAds = await pool.query("SELECT COUNT(*) FROM ads WHERE status='pending'");
const approvedAds = await pool.query("SELECT COUNT(*) FROM ads WHERE status='approved'");

res.json({
  total_ads: totalAds.rows[0].count,
  total_users: totalUsers.rows[0].count,
  pending_ads: pendingAds.rows[0].count,
  approved_ads: approvedAds.rows[0].count
});
});

/* جلب كل الإعلانات */
app.get("/api/admin/ads", async(req,res)=>{
if(!(await isAdmin(req))) return res.status(401).json({});
const r = await pool.query("SELECT * FROM ads ORDER BY created_at DESC");
res.json(r.rows);
});

/* قبول إعلان */
app.put("/api/admin/ads/:id/approve", async(req,res)=>{
if(!(await isAdmin(req))) return res.status(401).json({});
await pool.query("UPDATE ads SET status='approved' WHERE id=$1",[req.params.id]);
res.json({message:"تم قبول الإعلان"});
});

/* رفض إعلان */
app.put("/api/admin/ads/:id/reject", async(req,res)=>{
if(!(await isAdmin(req))) return res.status(401).json({});
await pool.query("UPDATE ads SET status='rejected' WHERE id=$1",[req.params.id]);
res.json({message:"تم رفض الإعلان"});
});

/* حذف إعلان */
app.delete("/api/admin/ads/:id", async(req,res)=>{
if(!(await isAdmin(req))) return res.status(401).json({});
await pool.query("DELETE FROM ads WHERE id=$1",[req.params.id]);
res.json({message:"تم حذف الإعلان"});
});

/* جلب المستخدمين */
app.get("/api/admin/users", async(req,res)=>{
if(!(await isAdmin(req))) return res.status(401).json({});
const r = await pool.query("SELECT id,name,email,disabled,is_admin FROM users");
res.json(r.rows);
});

/* تعطيل مستخدم */
app.put("/api/admin/users/:id/disable", async(req,res)=>{
if(!(await isAdmin(req))) return res.status(401).json({});
await pool.query("UPDATE users SET disabled=TRUE WHERE id=$1",[req.params.id]);
res.json({message:"تم تعطيل الحساب"});
});

/* تفعيل مستخدم */
app.put("/api/admin/users/:id/enable", async(req,res)=>{
if(!(await isAdmin(req))) return res.status(401).json({});
await pool.query("UPDATE users SET disabled=FALSE WHERE id=$1",[req.params.id]);
res.json({message:"تم تفعيل الحساب"});
});

/* حذف مستخدم */
app.delete("/api/admin/users/:id", async(req,res)=>{
if(!(await isAdmin(req))) return res.status(401).json({});
await pool.query("DELETE FROM users WHERE id=$1",[req.params.id]);
res.json({message:"تم حذف المستخدم"});
});

/* ---------------- ADS ---------------- */

app.post("/api/ads",
upload.fields([{name:"images",maxCount:3},{name:"video",maxCount:1}]),
async(req,res)=>{
if(!isAuth(req)) return res.status(401).json({});

const id=Date.now().toString();
const ref="REF-"+Math.floor(Math.random()*999999);
const userId=getUserId(req);

const user=await pool.query("SELECT * FROM users WHERE id=$1",[userId]);
const u=user.rows[0];

const images=(req.files.images||[]).map(f=>"/uploads/"+f.filename);
const video=req.files.video?"/uploads/"+req.files.video[0].filename:null;

await pool.query(`
INSERT INTO ads(id,ref,title,description,price,city,category,images,video,
owner_id,owner_name,owner_email,owner_phone)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
`,[
id,ref,
req.body.title,
req.body.description,
req.body.price,
req.body.city,
req.body.category,
images,
video,
userId,
u.name,
u.email,
u.phone
]);

res.json({ad:{id}});
});

/* ---------------- STATIC ---------------- */

app.use("/uploads",express.static(UPLOADS));
app.use(express.static(path.join(__dirname,"public")));

app.get("*",(req,res)=>{
const file=path.join(__dirname,"public",req.path==="/"?"index.html":req.path+".html");
if(fs.existsSync(file)) return res.sendFile(file);
res.status(404).send("الصفحة غير موجودة");
});

/* ---------------- START ---------------- */

initDatabase().then(()=>{
app.listen(PORT,()=>console.log("Server started"));
});