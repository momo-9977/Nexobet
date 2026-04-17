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
  if(!r.rows.length) return false;
  return r.rows[0].is_admin === true;
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

res.cookie("auth","1",{httpOnly:true,path:"/"});
res.cookie("userId",user.id,{httpOnly:true,path:"/"});
res.json({message:"تم الدخول", isAdmin:user.is_admin});
});

app.get("/api/auth/me", async(req,res)=>{
if(!isAuth(req)) return res.status(401).json({});
const id=getUserId(req);
const r=await pool.query("SELECT * FROM users WHERE id=$1",[id]);
res.json(r.rows[0]);
});

/* ---------------- ADMIN ---------------- */

app.get("/api/admin/init", async(req,res)=>{
if(!(await isAdmin(req))){
  return res.status(401).json({message:"غير مصرح"});
}

const ads = await pool.query("SELECT COUNT(*) FROM ads");
const users = await pool.query("SELECT COUNT(*) FROM users");
const pending = await pool.query("SELECT COUNT(*) FROM ads WHERE status='pending'");

res.json({
  total_ads: ads.rows[0].count,
  total_users: users.rows[0].count,
  pending_ads: pending.rows[0].count
});
});

app.get("/admin", async(req,res)=>{
if(!(await isAdmin(req))){
  return res.redirect("/login");
}
res.sendFile(path.join(__dirname,"public","admin.html"));
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

/* GET SINGLE AD */
app.get("/api/ads/:id", async(req,res)=>{
const r=await pool.query("SELECT * FROM ads WHERE id=$1",[req.params.id]);
if(!r.rows.length) return res.status(404).json({});
res.json(r.rows[0]);
});

/* EDIT */
app.put("/api/ads/:id",
upload.fields([{name:"images",maxCount:3},{name:"video",maxCount:1}]),
async(req,res)=>{

const id=req.params.id;
await pool.query(`
UPDATE ads SET title=$1,description=$2,price=$3,city=$4,category=$5
WHERE id=$6
`,[
req.body.title,
req.body.description,
req.body.price,
req.body.city,
req.body.category,
id
]);

res.json({message:"تم التعديل"});
});

/* DELETE */
app.delete("/api/ads/:id", async(req,res)=>{
await pool.query("DELETE FROM ads WHERE id=$1",[req.params.id]);
res.json({message:"تم الحذف"});
});

/* MY ADS */
app.get("/api/my/ads", async(req,res)=>{
if(!isAuth(req)) return res.status(401).json({});
const id=getUserId(req);
const r=await pool.query("SELECT * FROM ads WHERE owner_id=$1",[id]);
res.json(r.rows);
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