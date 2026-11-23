'use strict';
const express = require('express');
const { get, all } = require('../db');
const { COVER_SQL } = require('./listings');

const router = express.Router();

router.get('/u/:username', (req, res) => {
  const profile = get(
    'SELECT id, username, display_name, bio, location, role, banned, created_at, last_seen_at FROM users WHERE username = ?',
    req.params.username
  );
  const isAdmin = req.user?.role === 'admin';
  if (!profile || (profile.banned && !isAdmin)) {
    return res.status(404).render('error', { title: 'Not found', status: 404, message: 'That user does not exist.' });
  }
  const listings = all(
    `SELECT l.*, ${COVER_SQL} FROM listings l WHERE l.seller_id = ? AND l.status IN ('active','reserved','sold')
      ORDER BY CASE l.status WHEN 'active' THEN 0 WHEN 'reserved' THEN 1 ELSE 2 END, l.created_at DESC LIMIT 60`,
    profile.id
  );
  const stats = get(
    `SELECT (SELECT COUNT(*) FROM orders WHERE seller_id = ? AND status = 'completed') AS sales,
            (SELECT COUNT(*) FROM orders WHERE buyer_id = ? AND status = 'completed') AS purchases`,
    profile.id, profile.id
  );
  const favIds = req.user
    ? new Set(all('SELECT listing_id FROM favorites WHERE user_id = ?', req.user.id).map((r) => r.listing_id))
    : new Set();
  res.render('profile', { title: profile.display_name, profile, listings, stats, favIds });
});

module.exports = router;
