'use strict';
const crypto = require('node:crypto');
const { get, run } = require('./db');
const util = require('./util');

/** Loads the logged-in user on every request; kicks out banned users. */
function loadUser(req, res, next) {
  res.locals.currentUser = null;
  if (req.session.userId) {
    const user = get(
      'SELECT id, username, email, display_name, role, banned, ban_reason, balance_cents, bio, location FROM users WHERE id = ?',
      req.session.userId
    );
    if (!user || user.banned) {
      const reason = user?.ban_reason;
      return req.session.regenerate(() => {
        req.session.flash = [{ type: 'error', text: user ? `Your account has been suspended. Reason: ${reason}` : 'Please sign in again.' }];
        res.redirect('/login');
      });
    }
    req.user = user;
    res.locals.currentUser = user;
    // Throttle last-seen updates to once a minute.
    const now = Date.now();
    if (!req.session.seenAt || now - req.session.seenAt > 60000) {
      req.session.seenAt = now;
      run("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?", user.id);
    }
  }
  next();
}

/** CSRF protection: per-session token checked on all state-changing requests. */
function csrf(req, res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // Multipart bodies are parsed later by multer; those routes call verifyCsrf themselves.
  if (req.is('multipart/form-data')) return next();
  return verifyCsrf(req, res, next);
}

function verifyCsrf(req, res, next) {
  const token = (req.body && req.body._csrf) || req.get('x-csrf-token');
  const expected = req.session.csrfToken;
  if (
    typeof token !== 'string' || !expected || token.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  ) {
    const err = new Error('Your session expired or the form was tampered with. Please go back, reload and try again.');
    err.status = 403;
    err.expose = true;
    return next(err);
  }
  next();
}

function flash(req, res, next) {
  res.locals.flash = req.session.flash || [];
  delete req.session.flash;
  req.flash = (type, text) => {
    req.session.flash = req.session.flash || [];
    req.session.flash.push({ type, text });
  };
  next();
}

function locals(req, res, next) {
  Object.assign(res.locals, {
    formatMoney: util.formatMoney,
    timeAgo: util.timeAgo,
    formatDate: util.formatDate,
    CATEGORIES: util.CATEGORIES,
    CONDITIONS: util.CONDITIONS,
    ORDER_STATUS_LABEL: util.ORDER_STATUS_LABEL,
    path: req.path,
    query: req.query,
    unreadCount: 0,
    openReports: 0,
    title: null,
  });
  if (req.user) {
    res.locals.unreadCount = get(
      `SELECT COUNT(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE (c.buyer_id = ? OR c.seller_id = ?) AND m.read_at IS NULL
          AND (m.sender_id IS NULL OR m.sender_id <> ?)`,
      req.user.id, req.user.id, req.user.id
    ).n;
    if (req.user.role === 'admin') {
      res.locals.openReports = get("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'").n;
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    if (req.path.startsWith('/api/') || req.xhr) return res.status(401).json({ error: 'Not signed in' });
    req.flash('info', 'Please sign in to continue.');
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    const err = new Error('Administrator access required.');
    err.status = 403;
    err.expose = true;
    return next(err);
  }
  next();
}

/** Simple in-memory fixed-window rate limiter. */
function rateLimit({ windowMs, max, message }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const key = req.ip + ':' + req.path;
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.reset < now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    if (entry.count > max) {
      const err = new Error(message || 'Too many requests, please slow down.');
      err.status = 429;
      err.expose = true;
      return next(err);
    }
    next();
  };
}

module.exports = { loadUser, csrf, verifyCsrf, flash, locals, requireAuth, requireAdmin, rateLimit };
