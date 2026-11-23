'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { get, run } = require('../db');
const { str } = require('../util');
const { rateLimit, requireAuth } = require('../middleware');

const router = express.Router();
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser', 12);
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: 'Too many attempts. Please wait a few minutes and try again.' });

function safeNext(next) {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

function signIn(req, user, cb) {
  req.session.regenerate((err) => {
    if (err) return cb(err);
    req.session.userId = user.id;
    req.session.save(cb);
  });
}

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('auth/register', { title: 'Create account', form: {}, errors: [] });
});

router.post('/register', authLimiter, async (req, res, next) => {
  const form = {
    username: str(req.body.username, 30),
    email: str(req.body.email, 200).toLowerCase(),
    display_name: str(req.body.display_name, 60),
  };
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const errors = [];
  if (!/^[a-zA-Z0-9_]{3,30}$/.test(form.username)) errors.push('Username must be 3–30 characters: letters, numbers or underscores.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) errors.push('Please enter a valid email address.');
  if (password.length < 8) errors.push('Password must be at least 8 characters.');
  if (password.length > 200) errors.push('Password is too long.');
  if (password !== req.body.password_confirm) errors.push('Passwords do not match.');
  if (!errors.length) {
    if (get('SELECT 1 FROM users WHERE username = ?', form.username)) errors.push('That username is taken.');
    if (get('SELECT 1 FROM users WHERE email = ?', form.email)) errors.push('An account with that email already exists.');
  }
  if (errors.length) return res.status(400).render('auth/register', { title: 'Create account', form, errors });

  const hash = await bcrypt.hash(password, 12);
  const r = run(
    'INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)',
    form.username, form.email, hash, form.display_name || form.username
  );
  signIn(req, { id: Number(r.lastInsertRowid) }, (err) => {
    if (err) return next(err);
    req.flash('success', 'Welcome to Yard Marketplace! Add funds to your wallet to start buying, or post your first item.');
    res.redirect('/');
  });
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('auth/login', { title: 'Sign in', form: {}, error: null, next: safeNext(req.query.next) });
});

router.post('/login', authLimiter, async (req, res, next) => {
  const login = str(req.body.login, 200);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const nextUrl = safeNext(req.body.next);
  const user = get('SELECT * FROM users WHERE username = ? OR email = ?', login, login.toLowerCase());
  const ok = user ? await bcrypt.compare(password, user.password_hash) : await bcrypt.compare(password, DUMMY_HASH) && false;
  if (!user || !ok) {
    return res.status(401).render('auth/login', { title: 'Sign in', form: { login }, error: 'Incorrect username/email or password.', next: nextUrl });
  }
  if (user.banned) {
    return res.status(403).render('auth/login', {
      title: 'Sign in', form: { login }, next: nextUrl,
      error: `This account has been suspended. Reason: ${user.ban_reason || 'Violation of marketplace rules'}`,
    });
  }
  signIn(req, user, (err) => {
    if (err) return next(err);
    res.redirect(nextUrl);
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('yard.sid');
    res.redirect('/');
  });
});

/* ------------------------------------------------------------- settings */

router.get('/settings', requireAuth, (req, res) => {
  res.render('settings', { title: 'Account settings' });
});

router.post('/settings/profile', requireAuth, (req, res) => {
  const display_name = str(req.body.display_name, 60) || req.user.username;
  const bio = str(req.body.bio, 500);
  const location = str(req.body.location, 100);
  const email = str(req.body.email, 200).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    req.flash('error', 'Please enter a valid email address.');
    return res.redirect('/settings');
  }
  if (get('SELECT 1 FROM users WHERE email = ? AND id <> ?', email, req.user.id)) {
    req.flash('error', 'That email is already used by another account.');
    return res.redirect('/settings');
  }
  run('UPDATE users SET display_name = ?, bio = ?, location = ?, email = ? WHERE id = ?', display_name, bio, location, email, req.user.id);
  req.flash('success', 'Profile updated.');
  res.redirect('/settings');
});

router.post('/settings/password', requireAuth, authLimiter, async (req, res) => {
  const user = get('SELECT password_hash FROM users WHERE id = ?', req.user.id);
  const current = String(req.body.current_password || '');
  const next = String(req.body.new_password || '');
  if (!(await bcrypt.compare(current, user.password_hash))) {
    req.flash('error', 'Your current password is incorrect.');
  } else if (next.length < 8 || next.length > 200) {
    req.flash('error', 'New password must be at least 8 characters.');
  } else if (next !== req.body.new_password_confirm) {
    req.flash('error', 'New passwords do not match.');
  } else {
    run('UPDATE users SET password_hash = ? WHERE id = ?', await bcrypt.hash(next, 12), req.user.id);
    // Sign out other sessions.
    run("DELETE FROM sessions WHERE json_extract(data, '$.userId') = ? AND sid <> ?", req.user.id, req.sessionID);
    req.flash('success', 'Password changed. Other devices have been signed out.');
  }
  res.redirect('/settings');
});

module.exports = router;
