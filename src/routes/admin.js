'use strict';
const express = require('express');
const { get, all, run, transaction } = require('../db');
const { str, intParam } = require('../util');
const svc = require('../services');
const { removeFile } = require('../upload');
const { COVER_SQL } = require('./listings');

const router = express.Router();
const PAGE = 50;

function likeParam(q) {
  return '%' + q.replace(/[%_\\]/g, (c) => '\\' + c) + '%';
}

router.get('/', (req, res) => {
  const stats = get(`
    SELECT (SELECT COUNT(*) FROM users) AS users,
           (SELECT COUNT(*) FROM users WHERE banned = 1) AS banned,
           (SELECT COUNT(*) FROM users WHERE created_at >= datetime('now','-7 days')) AS new_users,
           (SELECT COUNT(*) FROM listings WHERE status = 'active') AS active_listings,
           (SELECT COUNT(*) FROM listings WHERE status = 'removed') AS removed_listings,
           (SELECT COUNT(*) FROM listings WHERE created_at >= datetime('now','-7 days')) AS new_listings,
           (SELECT COUNT(*) FROM orders) AS orders,
           (SELECT COUNT(*) FROM orders WHERE status IN ('paid','shipped')) AS open_orders,
           (SELECT COALESCE(SUM(amount_cents),0) FROM orders WHERE status = 'completed') AS gmv,
           (SELECT COALESCE(SUM(amount_cents),0) FROM orders WHERE status IN ('paid','shipped')) AS escrow,
           (SELECT COUNT(*) FROM reports WHERE status = 'open') AS open_reports,
           (SELECT COUNT(*) FROM messages) AS messages`);
  const reports = all(
    `SELECT r.*, l.title, u.username AS reporter FROM reports r
       LEFT JOIN listings l ON l.id = r.listing_id JOIN users u ON u.id = r.reporter_id
      WHERE r.status = 'open' ORDER BY r.id DESC LIMIT 5`
  );
  const log = all(
    `SELECT a.*, u.username AS admin FROM admin_log a LEFT JOIN users u ON u.id = a.admin_id ORDER BY a.id DESC LIMIT 8`
  );
  const daily = all(`
    SELECT date(created_at) AS day, COUNT(*) AS n FROM listings
     WHERE created_at >= date('now','-13 days') GROUP BY day ORDER BY day`);
  res.render('admin/index', { title: 'Admin', stats, reports, log, daily });
});

/* ------------------------------------------------------------------ users */

router.get('/users', (req, res) => {
  const q = str(req.query.q, 100);
  const filter = ['banned', 'admin'].includes(req.query.filter) ? req.query.filter : '';
  const where = ['1=1'];
  const params = [];
  if (q) { where.push("(username LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')"); params.push(likeParam(q), likeParam(q), likeParam(q)); }
  if (filter === 'banned') where.push('banned = 1');
  if (filter === 'admin') where.push("role = 'admin'");
  const users = all(
    `SELECT u.*,
            (SELECT COUNT(*) FROM listings WHERE seller_id = u.id AND status <> 'removed') AS listings,
            (SELECT COUNT(*) FROM orders WHERE seller_id = u.id AND status = 'completed') AS sales,
            (SELECT COUNT(*) FROM reports r JOIN listings l ON l.id = r.listing_id WHERE l.seller_id = u.id) AS reports
       FROM users u WHERE ${where.join(' AND ')} ORDER BY u.id DESC LIMIT ${PAGE}`,
    ...params
  );
  res.render('admin/users', { title: 'Manage users', users, q, filter });
});

router.get('/users/:id', (req, res) => {
  const user = get('SELECT * FROM users WHERE id = ?', intParam(req.params.id));
  if (!user) throw new svc.AppError('User not found.', 404);
  const listings = all(`SELECT l.*, ${COVER_SQL} FROM listings l WHERE seller_id = ? ORDER BY id DESC`, user.id);
  const orders = all(
    `SELECT o.*, b.username AS buyer_username, s.username AS seller_username FROM orders o
       JOIN users b ON b.id = o.buyer_id JOIN users s ON s.id = o.seller_id
      WHERE o.buyer_id = ? OR o.seller_id = ? ORDER BY o.id DESC LIMIT 50`,
    user.id, user.id
  );
  const txs = all('SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY id DESC LIMIT 30', user.id);
  const log = all(
    `SELECT a.*, u.username AS admin FROM admin_log a LEFT JOIN users u ON u.id = a.admin_id
      WHERE a.target_type = 'user' AND a.target_id = ? ORDER BY a.id DESC`, user.id
  );
  res.render('admin/user', { title: `User · ${user.username}`, user, listings, orders, txs, log });
});

router.post('/users/:id/ban', (req, res) => {
  const id = intParam(req.params.id);
  try {
    const refunded = svc.banUser(req.user, id, str(req.body.reason, 300));
    req.flash('success', `User banned.${refunded ? ` ${refunded} open order(s) were cancelled and refunded.` : ''}`);
  } catch (e) {
    if (!(e instanceof svc.AppError)) throw e;
    req.flash('error', e.message);
  }
  res.redirect(req.get('referer') || `/admin/users/${id}`);
});

router.post('/users/:id/unban', (req, res) => {
  const id = intParam(req.params.id);
  svc.unbanUser(req.user, id);
  req.flash('success', 'User reinstated.');
  res.redirect(req.get('referer') || `/admin/users/${id}`);
});

router.post('/users/:id/role', (req, res) => {
  const id = intParam(req.params.id);
  const role = req.body.role === 'admin' ? 'admin' : 'user';
  const user = get('SELECT * FROM users WHERE id = ?', id);
  if (!user) throw new svc.AppError('User not found.', 404);
  if (user.banned && role === 'admin') throw new svc.AppError('Unban the user before making them an admin.');
  if (role === 'user' && user.role === 'admin') {
    const admins = get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND banned = 0").n;
    if (admins <= 1) throw new svc.AppError('There must be at least one administrator.');
  }
  run('UPDATE users SET role = ? WHERE id = ?', role, id);
  svc.logAdmin(req.user.id, role === 'admin' ? 'promote_admin' : 'demote_admin', 'user', id);
  req.flash('success', role === 'admin' ? `${user.username} is now an administrator.` : `${user.username} is no longer an administrator.`);
  res.redirect(`/admin/users/${id}`);
});

router.post('/users/:id/adjust', (req, res) => {
  const id = intParam(req.params.id);
  const { parseMoney } = require('../util');
  const sign = req.body.direction === 'debit' ? -1 : 1;
  const amount = parseMoney(req.body.amount);
  const note = str(req.body.note, 200);
  if (!amount) throw new svc.AppError('Enter a valid amount.');
  if (!note) throw new svc.AppError('A note is required for balance adjustments.');
  svc.adjustBalance(id, sign * amount, 'adjustment', { note: `Admin adjustment: ${note}` });
  svc.logAdmin(req.user.id, 'adjust_balance', 'user', id, `${sign > 0 ? '+' : '-'}${(amount / 100).toFixed(2)} ${note}`);
  req.flash('success', 'Balance adjusted.');
  res.redirect(`/admin/users/${id}`);
});

/* --------------------------------------------------------------- listings */

router.get('/listings', (req, res) => {
  const q = str(req.query.q, 100);
  const status = ['active', 'reserved', 'sold', 'removed'].includes(req.query.status) ? req.query.status : '';
  const where = ['1=1'];
  const params = [];
  if (q) { where.push("(l.title LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\')"); params.push(likeParam(q), likeParam(q)); }
  if (status) { where.push('l.status = ?'); params.push(status); }
  const listings = all(
    `SELECT l.*, u.username, u.banned AS seller_banned, ${COVER_SQL},
            (SELECT COUNT(*) FROM reports r WHERE r.listing_id = l.id AND r.status = 'open') AS open_reports
       FROM listings l JOIN users u ON u.id = l.seller_id
      WHERE ${where.join(' AND ')} ORDER BY l.id DESC LIMIT ${PAGE * 2}`,
    ...params
  );
  res.render('admin/listings', { title: 'Manage listings', listings, q, status });
});

function removeListing(admin, listingId, reason) {
  return transaction(() => {
    const listing = get('SELECT * FROM listings WHERE id = ?', listingId);
    if (!listing) throw new svc.AppError('Listing not found.', 404);
    const open = all("SELECT id FROM orders WHERE listing_id = ? AND status IN ('paid','shipped')", listingId);
    for (const o of open) svc.cancelOrder(o.id, admin, 'listing removed by moderator');
    run("UPDATE listings SET status = 'removed', removed_reason = ?, updated_at = datetime('now') WHERE id = ?", reason || 'Violates marketplace rules', listingId);
    run("UPDATE reports SET status = 'resolved', resolved_by = ? WHERE listing_id = ? AND status = 'open'", admin.id, listingId);
    svc.logAdmin(admin.id, 'remove_listing', 'listing', listingId, `${listing.title} — ${reason}`);
  });
}

router.post('/listings/:id/remove', (req, res) => {
  removeListing(req.user, intParam(req.params.id), str(req.body.reason, 300));
  req.flash('success', 'Listing removed from the marketplace. The seller can see the reason on their dashboard.');
  res.redirect(req.get('referer') || '/admin/listings');
});

router.post('/listings/:id/restore', (req, res) => {
  const id = intParam(req.params.id);
  run("UPDATE listings SET status = 'active', removed_reason = NULL, updated_at = datetime('now') WHERE id = ? AND status = 'removed'", id);
  svc.logAdmin(req.user.id, 'restore_listing', 'listing', id);
  req.flash('success', 'Listing restored.');
  res.redirect(req.get('referer') || '/admin/listings');
});

router.post('/listings/:id/delete', (req, res) => {
  const id = intParam(req.params.id);
  const listing = get('SELECT * FROM listings WHERE id = ?', id);
  if (!listing) throw new svc.AppError('Listing not found.', 404);
  transaction(() => {
    const open = all("SELECT id FROM orders WHERE listing_id = ? AND status IN ('paid','shipped')", id);
    for (const o of open) svc.cancelOrder(o.id, req.user, 'listing deleted by moderator');
    const images = all('SELECT filename FROM listing_images WHERE listing_id = ?', id);
    run('DELETE FROM listings WHERE id = ?', id);
    images.forEach((i) => removeFile(i.filename));
    svc.logAdmin(req.user.id, 'delete_listing', 'listing', id, `${listing.title} (seller #${listing.seller_id}) ${str(req.body.reason, 300)}`);
  });
  req.flash('success', 'Listing permanently deleted.');
  res.redirect(req.body.back === 'user' ? `/admin/users/${listing.seller_id}` : '/admin/listings');
});

/* ---------------------------------------------------------------- reports */

router.get('/reports', (req, res) => {
  const status = ['resolved', 'dismissed'].includes(req.query.status) ? req.query.status : 'open';
  const reports = all(
    `SELECT r.*, l.title, l.status AS listing_status, l.seller_id, s.username AS seller, s.banned AS seller_banned,
            u.username AS reporter, a.username AS resolver,
            (SELECT filename FROM listing_images i WHERE i.listing_id = l.id ORDER BY position, id LIMIT 1) AS cover
       FROM reports r
       LEFT JOIN listings l ON l.id = r.listing_id
       LEFT JOIN users s ON s.id = l.seller_id
       JOIN users u ON u.id = r.reporter_id
       LEFT JOIN users a ON a.id = r.resolved_by
      WHERE r.status = ? ORDER BY r.id DESC LIMIT 200`,
    status
  );
  res.render('admin/reports', { title: 'Reports', reports, status });
});

router.post('/reports/:id/dismiss', (req, res) => {
  const id = intParam(req.params.id);
  run("UPDATE reports SET status = 'dismissed', resolved_by = ? WHERE id = ?", req.user.id, id);
  svc.logAdmin(req.user.id, 'dismiss_report', 'report', id);
  req.flash('success', 'Report dismissed.');
  res.redirect('/admin/reports');
});

/* ----------------------------------------------------------------- orders */

router.get('/orders', (req, res) => {
  const status = ['paid', 'shipped', 'completed', 'cancelled'].includes(req.query.status) ? req.query.status : '';
  const orders = all(
    `SELECT o.*, b.username AS buyer_username, s.username AS seller_username FROM orders o
       JOIN users b ON b.id = o.buyer_id JOIN users s ON s.id = o.seller_id
      ${status ? 'WHERE o.status = ?' : ''} ORDER BY o.id DESC LIMIT 200`,
    ...(status ? [status] : [])
  );
  res.render('admin/orders', { title: 'Orders', orders, status });
});

/* -------------------------------------------------------------------- log */

router.get('/log', (req, res) => {
  const log = all(
    `SELECT a.*, u.username AS admin FROM admin_log a LEFT JOIN users u ON u.id = a.admin_id ORDER BY a.id DESC LIMIT 300`
  );
  res.render('admin/log', { title: 'Moderation log', log });
});

module.exports = router;
