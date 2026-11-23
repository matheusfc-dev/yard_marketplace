'use strict';
const express = require('express');
const { get, all, run } = require('../db');
const { str, intParam } = require('../util');
const { requireAuth, rateLimit } = require('../middleware');
const { AppError, getOrCreateConversation, addMessage } = require('../services');

const router = express.Router();
const sendLimiter = rateLimit({ windowMs: 60 * 1000, max: 40, message: 'You are sending messages too quickly.' });

function loadConversation(req) {
  const conv = get(
    `SELECT c.*, b.username AS buyer_username, b.display_name AS buyer_name, b.banned AS buyer_banned,
            s.username AS seller_username, s.display_name AS seller_name, s.banned AS seller_banned,
            l.status AS listing_status, l.price_cents,
            (SELECT filename FROM listing_images i WHERE i.listing_id = c.listing_id ORDER BY position, id LIMIT 1) AS cover
       FROM conversations c
       JOIN users b ON b.id = c.buyer_id
       JOIN users s ON s.id = c.seller_id
       LEFT JOIN listings l ON l.id = c.listing_id
      WHERE c.id = ?`,
    intParam(req.params.id)
  );
  if (!conv || (conv.buyer_id !== req.user.id && conv.seller_id !== req.user.id)) {
    throw new AppError('Conversation not found.', 404);
  }
  return conv;
}

function messagesAfter(convId, afterId = 0) {
  return all(
    `SELECT m.id, m.sender_id, m.is_system, m.body, m.created_at, m.read_at
       FROM messages m WHERE m.conversation_id = ? AND m.id > ? ORDER BY m.id ASC LIMIT 500`,
    convId, afterId
  );
}

function markRead(convId, userId) {
  run(
    `UPDATE messages SET read_at = datetime('now')
      WHERE conversation_id = ? AND read_at IS NULL AND (sender_id IS NULL OR sender_id <> ?)`,
    convId, userId
  );
}

function inbox(userId) {
  return all(
    `SELECT c.*,
            CASE WHEN c.buyer_id = ? THEN s.display_name ELSE b.display_name END AS other_name,
            CASE WHEN c.buyer_id = ? THEN s.username ELSE b.username END AS other_username,
            CASE WHEN c.buyer_id = ? THEN 'buying' ELSE 'selling' END AS role,
            (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_body,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.read_at IS NULL
               AND (m.sender_id IS NULL OR m.sender_id <> ?)) AS unread,
            (SELECT filename FROM listing_images i WHERE i.listing_id = c.listing_id ORDER BY position, id LIMIT 1) AS cover
       FROM conversations c
       JOIN users b ON b.id = c.buyer_id
       JOIN users s ON s.id = c.seller_id
      WHERE (c.buyer_id = ? OR c.seller_id = ?)
        AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)
      ORDER BY c.updated_at DESC`,
    userId, userId, userId, userId, userId, userId
  );
}

router.get('/messages', requireAuth, (req, res) => {
  res.render('messages/inbox', { title: 'Messages', conversations: inbox(req.user.id), active: null, messages: [] });
});

router.get('/messages/:id', requireAuth, (req, res) => {
  const conv = loadConversation(req);
  markRead(conv.id, req.user.id);
  res.locals.unreadCount = get(
    `SELECT COUNT(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE (c.buyer_id = ? OR c.seller_id = ?) AND m.read_at IS NULL AND (m.sender_id IS NULL OR m.sender_id <> ?)`,
    req.user.id, req.user.id, req.user.id
  ).n;
  const messages = messagesAfter(conv.id);
  const order = conv.listing_id
    ? get("SELECT * FROM orders WHERE listing_id = ? AND buyer_id = ? ORDER BY id DESC LIMIT 1", conv.listing_id, conv.buyer_id)
    : null;
  res.render('messages/inbox', { title: 'Messages', conversations: inbox(req.user.id), active: conv, messages, order });
});

/** Start (or reopen) a conversation about a listing as a buyer. */
router.post('/listings/:id/contact', requireAuth, sendLimiter, (req, res) => {
  const listing = get(
    `SELECT l.*, u.banned FROM listings l JOIN users u ON u.id = l.seller_id WHERE l.id = ?`,
    intParam(req.params.id)
  );
  if (!listing || listing.status === 'removed' || listing.banned) throw new AppError('Listing not found.', 404);
  if (listing.seller_id === req.user.id) throw new AppError("You can't message yourself about your own listing.");
  const conv = getOrCreateConversation(listing, req.user.id);
  const body = str(req.body.body, 2000);
  if (body) addMessage(conv.id, req.user.id, body);
  res.redirect(`/messages/${conv.id}`);
});

/* --------------------------------------------------------------- JSON API */

router.get('/api/conversations/:id/messages', requireAuth, (req, res) => {
  const conv = loadConversation(req);
  const after = intParam(req.query.after, 0);
  const messages = messagesAfter(conv.id, after);
  if (messages.length) markRead(conv.id, req.user.id);
  // Read receipts for my own messages.
  const lastReadMine = get(
    'SELECT MAX(id) AS id FROM messages WHERE conversation_id = ? AND sender_id = ? AND read_at IS NOT NULL',
    conv.id, req.user.id
  ).id;
  res.json({ messages, lastReadMine });
});

router.post('/api/conversations/:id/messages', requireAuth, sendLimiter, (req, res) => {
  const conv = loadConversation(req);
  if (conv.buyer_banned || conv.seller_banned) throw new AppError('This conversation is closed because an account was suspended.', 403);
  const body = str(req.body.body, 2000);
  if (!body) throw new AppError('Message cannot be empty.');
  const message = addMessage(conv.id, req.user.id, body);
  res.status(201).json({ message });
});

router.get('/api/unread', requireAuth, (req, res) => {
  res.json({ unread: res.locals.unreadCount });
});

module.exports = router;
