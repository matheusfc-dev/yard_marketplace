'use strict';
const express = require('express');
const { get, all, run, transaction } = require('../db');
const { str, parseMoney, intParam, CATEGORIES, CONDITIONS } = require('../util');
const { requireAuth, verifyCsrf } = require('../middleware');
const { upload, keepRealImages, removeFile, MAX_IMAGES } = require('../upload');
const { AppError } = require('../services');

const router = express.Router();
const PAGE_SIZE = 24;

const SORTS = {
  newest: 'l.created_at DESC',
  oldest: 'l.created_at ASC',
  price_asc: 'l.price_cents ASC',
  price_desc: 'l.price_cents DESC',
  popular: 'l.views DESC',
};

const COVER_SQL = '(SELECT filename FROM listing_images i WHERE i.listing_id = l.id ORDER BY position, id LIMIT 1) AS cover';

/* ----------------------------------------------------------------- browse */

router.get('/', (req, res) => {
  const q = str(req.query.q, 100);
  const category = CATEGORIES.includes(req.query.category) ? req.query.category : '';
  const condition = CONDITIONS.includes(req.query.condition) ? req.query.condition : '';
  const sort = SORTS[req.query.sort] ? req.query.sort : 'newest';
  const min = parseMoney(req.query.min);
  const max = parseMoney(req.query.max);
  const page = intParam(req.query.page, 1);

  const where = ["l.status = 'active'", 'u.banned = 0'];
  const params = [];
  if (q) {
    const like = '%' + q.replace(/[%_\\]/g, (c) => '\\' + c) + '%';
    where.push("(l.title LIKE ? ESCAPE '\\' OR l.description LIKE ? ESCAPE '\\' OR l.location LIKE ? ESCAPE '\\')");
    params.push(like, like, like);
  }
  if (category) { where.push('l.category = ?'); params.push(category); }
  if (condition) { where.push('l.condition = ?'); params.push(condition); }
  if (min !== null) { where.push('l.price_cents >= ?'); params.push(min); }
  if (max !== null) { where.push('l.price_cents <= ?'); params.push(max); }

  const whereSql = where.join(' AND ');
  const total = get(`SELECT COUNT(*) AS n FROM listings l JOIN users u ON u.id = l.seller_id WHERE ${whereSql}`, ...params).n;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const listings = all(
    `SELECT l.*, u.username, u.display_name, ${COVER_SQL}
       FROM listings l JOIN users u ON u.id = l.seller_id
      WHERE ${whereSql}
      ORDER BY ${SORTS[sort]}, l.id DESC
      LIMIT ? OFFSET ?`,
    ...params, PAGE_SIZE, (Math.min(page, pages) - 1) * PAGE_SIZE
  );

  const categoryCounts = all(
    `SELECT l.category, COUNT(*) AS n FROM listings l JOIN users u ON u.id = l.seller_id
      WHERE l.status = 'active' AND u.banned = 0 GROUP BY l.category`
  );
  const favIds = req.user
    ? new Set(all('SELECT listing_id FROM favorites WHERE user_id = ?', req.user.id).map((r) => r.listing_id))
    : new Set();

  res.render('index', {
    title: null,
    listings, total, page: Math.min(page, pages), pages, favIds,
    filters: { q, category, condition, sort, min: req.query.min || '', max: req.query.max || '' },
    categoryCounts: Object.fromEntries(categoryCounts.map((c) => [c.category, c.n])),
  });
});

/* --------------------------------------------------------------- helpers */

function loadListing(id) {
  return get(
    `SELECT l.*, u.username, u.display_name, u.banned AS seller_banned, u.created_at AS seller_since, u.location AS seller_location,
            u.last_seen_at AS seller_last_seen
       FROM listings l JOIN users u ON u.id = l.seller_id WHERE l.id = ?`,
    id
  );
}

function ownedListing(req) {
  const listing = loadListing(intParam(req.params.id));
  if (!listing) throw new AppError('Listing not found.', 404);
  if (listing.seller_id !== req.user.id && req.user.role !== 'admin') throw new AppError('You can only edit your own listings.', 403);
  return listing;
}

function validateListing(body) {
  const data = {
    title: str(body.title, 120),
    description: str(body.description, 5000),
    price_cents: parseMoney(body.price),
    category: body.category,
    condition: body.condition,
    location: str(body.location, 100),
  };
  const errors = [];
  if (data.title.length < 3) errors.push('Title must be at least 3 characters.');
  if (data.description.length < 10) errors.push('Description must be at least 10 characters.');
  if (data.price_cents === null) errors.push('Enter a valid price, e.g. 25 or 19.99.');
  if (!CATEGORIES.includes(data.category)) errors.push('Choose a category.');
  if (!CONDITIONS.includes(data.condition)) errors.push('Choose a condition.');
  return { data, errors };
}

function discardUploads(files) {
  for (const f of files || []) removeFile(f.filename);
}

const uploadImages = (req, res, next) =>
  upload.array('images', MAX_IMAGES)(req, res, (err) => {
    if (err) {
      discardUploads(req.files);
      return next(err);
    }
    next();
  });

// CSRF for multipart routes must run after multer parsed the body.
const csrfAfterUpload = (req, res, next) =>
  verifyCsrf(req, res, (err) => {
    if (err) discardUploads(req.files);
    next(err);
  });

/* ----------------------------------------------------------------- create */

router.get('/listings/new', requireAuth, (req, res) => {
  res.render('listings/form', { title: 'Sell an item', listing: { location: req.user.location }, images: [], errors: [], isNew: true });
});

router.post('/listings', requireAuth, uploadImages, csrfAfterUpload, (req, res) => {
  const files = keepRealImages(req.files);
  const { data, errors } = validateListing(req.body);
  if (!files.length) errors.push('Add at least one photo (JPG, PNG, WEBP or GIF).');
  if (errors.length) {
    discardUploads(files);
    return res.status(400).render('listings/form', { title: 'Sell an item', listing: { ...req.body }, images: [], errors, isNew: true });
  }
  const id = transaction(() => {
    const r = run(
      `INSERT INTO listings (seller_id, title, description, price_cents, category, condition, location)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      req.user.id, data.title, data.description, data.price_cents, data.category, data.condition, data.location
    );
    const listingId = Number(r.lastInsertRowid);
    files.forEach((f, i) => run('INSERT INTO listing_images (listing_id, filename, position) VALUES (?, ?, ?)', listingId, f.filename, i));
    return listingId;
  });
  req.flash('success', 'Your item is live! Buyers can now message you or buy it.');
  res.redirect(`/listings/${id}`);
});

/* ------------------------------------------------------------------- view */

router.get('/listings/:id', (req, res) => {
  const listing = loadListing(intParam(req.params.id));
  const isOwner = req.user && listing && listing.seller_id === req.user.id;
  const isAdmin = req.user?.role === 'admin';
  if (!listing || ((listing.status === 'removed' || listing.seller_banned) && !isOwner && !isAdmin)) {
    return res.status(404).render('error', { title: 'Not found', status: 404, message: 'This listing is no longer available.' });
  }
  if (!isOwner) {
    const seen = (req.session.viewed ||= []);
    if (!seen.includes(listing.id)) {
      run('UPDATE listings SET views = views + 1 WHERE id = ?', listing.id);
      seen.push(listing.id);
      if (seen.length > 200) seen.shift();
    }
  }
  const images = all('SELECT * FROM listing_images WHERE listing_id = ? ORDER BY position, id', listing.id);
  const sellerStats = get(
    `SELECT (SELECT COUNT(*) FROM orders WHERE seller_id = ? AND status = 'completed') AS sales,
            (SELECT COUNT(*) FROM listings WHERE seller_id = ? AND status = 'active') AS active`,
    listing.seller_id, listing.seller_id
  );
  const more = all(
    `SELECT l.*, ${COVER_SQL} FROM listings l WHERE l.seller_id = ? AND l.id <> ? AND l.status = 'active' ORDER BY l.created_at DESC LIMIT 4`,
    listing.seller_id, listing.id
  );
  let favorited = false, conversation = null, myOrder = null;
  if (req.user) {
    favorited = !!get('SELECT 1 FROM favorites WHERE user_id = ? AND listing_id = ?', req.user.id, listing.id);
    conversation = get('SELECT id FROM conversations WHERE listing_id = ? AND buyer_id = ?', listing.id, req.user.id);
    myOrder = get(
      "SELECT * FROM orders WHERE listing_id = ? AND (buyer_id = ? OR seller_id = ?) AND status IN ('paid','shipped') ORDER BY id DESC LIMIT 1",
      listing.id, req.user.id, req.user.id
    );
  }
  res.render('listings/show', { title: listing.title, listing, images, sellerStats, more, favorited, conversation, myOrder, isOwner, isAdmin });
});

/* ------------------------------------------------------------------- edit */

router.get('/listings/:id/edit', requireAuth, (req, res) => {
  const listing = ownedListing(req);
  if (listing.status === 'removed' && req.user.role !== 'admin') throw new AppError('This listing was removed by a moderator and can no longer be edited.', 403);
  const images = all('SELECT * FROM listing_images WHERE listing_id = ? ORDER BY position, id', listing.id);
  res.render('listings/form', {
    title: 'Edit listing', images, errors: [], isNew: false,
    listing: { ...listing, price: (listing.price_cents / 100).toFixed(2) },
  });
});

router.post('/listings/:id/edit', requireAuth, uploadImages, csrfAfterUpload, (req, res) => {
  let listing;
  try { listing = ownedListing(req); } catch (e) { discardUploads(req.files); throw e; }
  if (listing.status === 'removed' && req.user.role !== 'admin') { discardUploads(req.files); throw new AppError('This listing was removed by a moderator.', 403); }
  const files = keepRealImages(req.files);
  const { data, errors } = validateListing(req.body);
  const existing = all('SELECT * FROM listing_images WHERE listing_id = ? ORDER BY position, id', listing.id);
  const removeIds = new Set([].concat(req.body.remove_images || []).map(Number));
  const kept = existing.filter((img) => !removeIds.has(img.id));
  if (kept.length + files.length === 0) errors.push('A listing needs at least one photo.');
  if (kept.length + files.length > MAX_IMAGES) errors.push(`A listing can have at most ${MAX_IMAGES} photos.`);
  if (listing.status === 'reserved' && data.price_cents !== listing.price_cents) errors.push("You can't change the price while an order is in progress.");
  if (errors.length) {
    discardUploads(files);
    return res.status(400).render('listings/form', { title: 'Edit listing', listing: { ...listing, ...req.body }, images: existing, errors, isNew: false });
  }
  transaction(() => {
    run(
      `UPDATE listings SET title = ?, description = ?, price_cents = ?, category = ?, condition = ?, location = ?, updated_at = datetime('now')
        WHERE id = ?`,
      data.title, data.description, data.price_cents, data.category, data.condition, data.location, listing.id
    );
    for (const img of existing) {
      if (removeIds.has(img.id)) {
        run('DELETE FROM listing_images WHERE id = ?', img.id);
        removeFile(img.filename);
      }
    }
    const start = kept.length;
    files.forEach((f, i) => run('INSERT INTO listing_images (listing_id, filename, position) VALUES (?, ?, ?)', listing.id, f.filename, start + i));
  });
  req.flash('success', 'Listing updated.');
  res.redirect(`/listings/${listing.id}`);
});

router.post('/listings/:id/status', requireAuth, (req, res) => {
  const listing = ownedListing(req);
  const status = req.body.status;
  if (listing.status === 'removed') throw new AppError('This listing was removed by a moderator.', 403);
  if (listing.status === 'reserved') throw new AppError('This item has an order in progress. Complete or cancel the order first.');
  if (!['active', 'sold'].includes(status)) throw new AppError('Invalid status.');
  run("UPDATE listings SET status = ?, updated_at = datetime('now') WHERE id = ?", status, listing.id);
  req.flash('success', status === 'sold' ? 'Marked as sold — it no longer shows in search.' : 'Listing is active again.');
  res.redirect(`/listings/${listing.id}`);
});

router.post('/listings/:id/delete', requireAuth, (req, res) => {
  const listing = ownedListing(req);
  if (listing.status === 'reserved') throw new AppError('This item has an order in progress. Complete or cancel the order first.');
  const images = all('SELECT filename FROM listing_images WHERE listing_id = ?', listing.id);
  run('DELETE FROM listings WHERE id = ?', listing.id);
  images.forEach((i) => removeFile(i.filename));
  req.flash('success', 'Listing deleted.');
  res.redirect('/dashboard');
});

/* ------------------------------------------------------- favorite, report */

router.post('/listings/:id/favorite', requireAuth, (req, res) => {
  const id = intParam(req.params.id);
  if (!get('SELECT 1 FROM listings WHERE id = ?', id)) throw new AppError('Listing not found.', 404);
  const exists = get('SELECT 1 FROM favorites WHERE user_id = ? AND listing_id = ?', req.user.id, id);
  if (exists) run('DELETE FROM favorites WHERE user_id = ? AND listing_id = ?', req.user.id, id);
  else run('INSERT INTO favorites (user_id, listing_id) VALUES (?, ?)', req.user.id, id);
  if (req.get('accept')?.includes('application/json')) return res.json({ favorited: !exists });
  res.redirect(req.get('referer') || `/listings/${id}`);
});

const REPORT_REASONS = ['Prohibited or illegal item', 'Scam or fraud', 'Counterfeit', 'Offensive content', 'Wrong category / spam', 'Other'];

router.post('/listings/:id/report', requireAuth, (req, res) => {
  const listing = loadListing(intParam(req.params.id));
  if (!listing) throw new AppError('Listing not found.', 404);
  const reason = REPORT_REASONS.includes(req.body.reason) ? req.body.reason : 'Other';
  if (get("SELECT 1 FROM reports WHERE listing_id = ? AND reporter_id = ? AND status = 'open'", listing.id, req.user.id)) {
    req.flash('info', 'You already reported this listing. Our moderators will review it.');
  } else {
    run('INSERT INTO reports (listing_id, reporter_id, reason, details) VALUES (?, ?, ?, ?)', listing.id, req.user.id, reason, str(req.body.details, 1000));
    req.flash('success', 'Thanks — a moderator will review this listing.');
  }
  res.redirect(`/listings/${listing.id}`);
});

/* ------------------------------------------------------ seller dashboard */

router.get('/dashboard', requireAuth, (req, res) => {
  const listings = all(
    `SELECT l.*, ${COVER_SQL},
            (SELECT COUNT(*) FROM conversations c WHERE c.listing_id = l.id) AS chats,
            (SELECT COUNT(*) FROM favorites f WHERE f.listing_id = l.id) AS saves
       FROM listings l WHERE l.seller_id = ? ORDER BY CASE l.status WHEN 'reserved' THEN 0 WHEN 'active' THEN 1 WHEN 'removed' THEN 2 ELSE 3 END, l.created_at DESC`,
    req.user.id
  );
  const stats = get(
    `SELECT (SELECT COUNT(*) FROM orders WHERE seller_id = ? AND status = 'completed') AS sold,
            (SELECT COALESCE(SUM(amount_cents),0) FROM orders WHERE seller_id = ? AND status = 'completed') AS earned,
            (SELECT COALESCE(SUM(amount_cents),0) FROM orders WHERE seller_id = ? AND status IN ('paid','shipped')) AS pending`,
    req.user.id, req.user.id, req.user.id
  );
  res.render('dashboard', { title: 'My listings', listings, stats });
});

router.get('/saved', requireAuth, (req, res) => {
  const listings = all(
    `SELECT l.*, u.username, u.display_name, ${COVER_SQL}
       FROM favorites f JOIN listings l ON l.id = f.listing_id JOIN users u ON u.id = l.seller_id
      WHERE f.user_id = ? AND l.status <> 'removed' AND u.banned = 0 ORDER BY f.created_at DESC`,
    req.user.id
  );
  res.render('saved', { title: 'Saved items', listings, favIds: new Set(listings.map((l) => l.id)) });
});

module.exports = router;
module.exports.COVER_SQL = COVER_SQL;
module.exports.REPORT_REASONS = REPORT_REASONS;
