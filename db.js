// db.js
const { Pool } = require('pg');

const connectionString =
  process.env.DATABASE_URL ||
  process.env.DATABASE_PUBLIC_URL ||
  process.env.POSTGRES_URL;

if (!connectionString) {
  console.error('❌ Missing DATABASE_URL (or DATABASE_PUBLIC_URL / POSTGRES_URL) in env variables');
}

const pool = new Pool({
  connectionString,
  ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false }
});

async function q(text, params) {
  return pool.query(text, params);
}

module.exports = { pool, q };