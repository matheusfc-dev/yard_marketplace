'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');

const { DATA_DIR } = require('./db');
const SqliteStore = require('./session-store');
const mw = require('./middleware');
const util = require('./util');
const { ensureAdmin } = require('./bootstrap');
const { UPLOAD_DIR } = require('./upload');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const isProd = process.env.NODE_ENV === 'production';

// Persist a session secret so logins survive restarts.
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(DATA_DIR, '.session-secret');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(48).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(file, 'utf8').trim();
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: isProd ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: isProd ? '7d' : 0 }));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', fallthrough: false }));

app.use(express.urlencoded({ extended: false, limit: '200kb' }));
app.use(express.json({ limit: '100kb' }));

app.use(session({
  store: new SqliteStore(),
  name: 'yard.sid',
  secret: sessionSecret(),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd && !!process.env.TRUST_PROXY ? true : 'auto',
    maxAge: 1000 * 60 * 60 * 24 * 14,
  },
}));

app.use(mw.flash);
app.use(mw.loadUser);
app.use(mw.locals);
app.use(mw.csrf);

app.use(require('./routes/auth'));
app.use(require('./routes/listings'));
app.use(require('./routes/messages'));
app.use(require('./routes/orders'));
app.use(require('./routes/wallet'));
app.use(require('./routes/users'));
app.use('/admin', mw.requireAuth, mw.requireAdmin, require('./routes/admin'));

app.get('/about', (req, res) => res.render('about', { title: 'How Yard works' }));

// 404
app.use((req, res) => {
  res.status(404).render('error', { title: 'Not found', status: 404, message: "We couldn't find that page." });
});

// Errors
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  let status = err.status || err.statusCode || 500;
  let message = err.expose ? err.message : 'Something went wrong on our side.';
  if (err.code === 'LIMIT_FILE_SIZE') { status = 400; message = 'Each image must be 5 MB or smaller.'; }
  if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') { status = 400; message = 'You can upload up to 8 images.'; }
  if (status >= 500) console.error(err);
  // Make sure the layout can render even if the error happened before the locals middleware ran.
  const defaults = {
    currentUser: null, csrfToken: req.session?.csrfToken || '', flash: [], unreadCount: 0, openReports: 0,
    path: req.path, query: req.query || {}, title: null,
    formatMoney: util.formatMoney, timeAgo: util.timeAgo, formatDate: util.formatDate,
  };
  for (const [k, v] of Object.entries(defaults)) if (res.locals[k] === undefined) res.locals[k] = v;
  if (req.path.startsWith('/api/') || req.xhr || req.get('accept')?.includes('application/json')) {
    return res.status(status).json({ error: message });
  }
  // Friendly redirect back for validation-type errors on form posts.
  if (status === 400 && req.method === 'POST' && req.get('referer') && req.session) {
    req.flash('error', message);
    return res.redirect(req.get('referer'));
  }
  res.status(status).render('error', { title: 'Error', status, message });
});

ensureAdmin();

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Yard Marketplace running at http://localhost:${PORT}`);
  });
}

module.exports = app;
