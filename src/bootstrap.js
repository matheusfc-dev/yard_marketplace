'use strict';
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { get, run } = require('./db');

/**
 * Make sure at least one admin account exists.
 * Credentials come from ADMIN_USERNAME / ADMIN_EMAIL / ADMIN_PASSWORD, otherwise a random password is printed once.
 */
function ensureAdmin() {
  const existing = get("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  if (existing) return;
  const username = process.env.ADMIN_USERNAME || 'admin';
  const email = process.env.ADMIN_EMAIL || 'admin@yard.local';
  const generated = !process.env.ADMIN_PASSWORD;
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  const taken = get('SELECT id FROM users WHERE username = ? OR email = ?', username, email);
  if (taken) {
    run("UPDATE users SET role = 'admin' WHERE id = ?", taken.id);
    console.log(`[yard] Promoted existing user "${username}" to admin.`);
    return;
  }
  run(
    "INSERT INTO users (username, email, password_hash, display_name, role) VALUES (?, ?, ?, ?, 'admin')",
    username, email, bcrypt.hashSync(password, 12), 'Yard Admin'
  );
  console.log('\n[yard] ===============================================');
  console.log('[yard] Created administrator account');
  console.log(`[yard]   username: ${username}`);
  if (generated) console.log(`[yard]   password: ${password}   <-- change it in Settings`);
  console.log('[yard] ===============================================\n');
}

module.exports = { ensureAdmin };
