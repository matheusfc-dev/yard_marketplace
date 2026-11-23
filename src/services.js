'use strict';
const { get, all, run, transaction } = require('./db');
const { formatMoney } = require('./util');

class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

/* ---------------------------------------------------------------- wallet */

function adjustBalance(userId, delta, type, { orderId = null, note = '' } = {}) {
  return transaction(() => {
    const user = get('SELECT id, balance_cents FROM users WHERE id = ?', userId);
    if (!user) throw new AppError('User not found', 404);
    const next = user.balance_cents + delta;
    if (next < 0) throw new AppError('Insufficient wallet balance.');
    run('UPDATE users SET balance_cents = ? WHERE id = ?', next, userId);
    run(
      `INSERT INTO wallet_transactions (user_id, amount_cents, type, order_id, note, balance_after)
       VALUES (?, ?, ?, ?, ?, ?)`,
      userId, delta, type, orderId, note, next
    );
    return next;
  });
}

/* --------------------------------------------------------- conversations */

function getOrCreateConversation(listing, buyerId) {
  let conv = get('SELECT * FROM conversations WHERE listing_id = ? AND buyer_id = ?', listing.id, buyerId);
  if (!conv) {
    const r = run(
      `INSERT INTO conversations (listing_id, listing_title, buyer_id, seller_id) VALUES (?, ?, ?, ?)`,
      listing.id, listing.title, buyerId, listing.seller_id
    );
    conv = get('SELECT * FROM conversations WHERE id = ?', r.lastInsertRowid);
  }
  return conv;
}

function addMessage(conversationId, senderId, body, isSystem = false) {
  const r = run(
    'INSERT INTO messages (conversation_id, sender_id, is_system, body) VALUES (?, ?, ?, ?)',
    conversationId, isSystem ? null : senderId, isSystem ? 1 : 0, body
  );
  run("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?", conversationId);
  return get('SELECT * FROM messages WHERE id = ?', r.lastInsertRowid);
}

function systemMessageForOrder(order, text) {
  if (!order.listing_id) return;
  const listing = get('SELECT id, title, seller_id FROM listings WHERE id = ?', order.listing_id);
  if (!listing) return;
  const conv = getOrCreateConversation(listing, order.buyer_id);
  addMessage(conv.id, null, text, true);
}

/* ---------------------------------------------------------------- orders */

function placeOrder(buyerId, listingId, shippingNote = '') {
  return transaction(() => {
    const listing = get(
      `SELECT l.*, u.banned AS seller_banned FROM listings l JOIN users u ON u.id = l.seller_id WHERE l.id = ?`,
      listingId
    );
    if (!listing) throw new AppError('Listing not found.', 404);
    if (listing.seller_id === buyerId) throw new AppError("You can't buy your own listing.");
    if (listing.status !== 'active' || listing.seller_banned) throw new AppError('This item is no longer available.');

    const r = run(
      `INSERT INTO orders (listing_id, listing_title, buyer_id, seller_id, amount_cents, shipping_note)
       VALUES (?, ?, ?, ?, ?, ?)`,
      listing.id, listing.title, buyerId, listing.seller_id, listing.price_cents, shippingNote.slice(0, 1000)
    );
    const orderId = Number(r.lastInsertRowid);
    adjustBalance(buyerId, -listing.price_cents, 'purchase', {
      orderId, note: `Payment held in escrow for "${listing.title}"`,
    });
    run("UPDATE listings SET status = 'reserved', updated_at = datetime('now') WHERE id = ?", listing.id);
    const order = getOrder(orderId);
    systemMessageForOrder(order, `🛒 Order #${orderId} placed — ${formatMoney(order.amount_cents)} is held safely in escrow until the buyer confirms receipt.`);
    return order;
  });
}

function getOrder(id) {
  return get(
    `SELECT o.*, b.username AS buyer_username, b.display_name AS buyer_name,
            s.username AS seller_username, s.display_name AS seller_name
       FROM orders o
       JOIN users b ON b.id = o.buyer_id
       JOIN users s ON s.id = o.seller_id
      WHERE o.id = ?`,
    id
  );
}

function markShipped(orderId, actorId) {
  return transaction(() => {
    const order = getOrder(orderId);
    if (!order) throw new AppError('Order not found.', 404);
    if (order.seller_id !== actorId) throw new AppError('Only the seller can mark an order as shipped.', 403);
    if (order.status !== 'paid') throw new AppError('Order cannot be marked as shipped in its current state.');
    run("UPDATE orders SET status = 'shipped', updated_at = datetime('now') WHERE id = ?", orderId);
    systemMessageForOrder(order, `📦 Order #${orderId} was marked as shipped / handed over by the seller.`);
    return getOrder(orderId);
  });
}

function confirmReceived(orderId, actorId) {
  return transaction(() => {
    const order = getOrder(orderId);
    if (!order) throw new AppError('Order not found.', 404);
    if (order.buyer_id !== actorId) throw new AppError('Only the buyer can confirm receipt.', 403);
    if (!['paid', 'shipped'].includes(order.status)) throw new AppError('Order is not awaiting confirmation.');
    run("UPDATE orders SET status = 'completed', updated_at = datetime('now') WHERE id = ?", orderId);
    adjustBalance(order.seller_id, order.amount_cents, 'sale', {
      orderId, note: `Sale of "${order.listing_title}" released from escrow`,
    });
    if (order.listing_id) {
      run("UPDATE listings SET status = 'sold', updated_at = datetime('now') WHERE id = ? AND status <> 'removed'", order.listing_id);
    }
    systemMessageForOrder(order, `✅ Order #${orderId} completed — the buyer confirmed receipt and ${formatMoney(order.amount_cents)} was released to the seller.`);
    return getOrder(orderId);
  });
}

/**
 * Cancel an order and refund the buyer.
 * actor: { id, role } — buyer (only before shipping), seller (any time before completion) or admin.
 */
function cancelOrder(orderId, actor, reason = '') {
  return transaction(() => {
    const order = getOrder(orderId);
    if (!order) throw new AppError('Order not found.', 404);
    if (!['paid', 'shipped'].includes(order.status)) throw new AppError('Only open orders can be cancelled.');
    const isAdmin = actor.role === 'admin';
    const isSeller = order.seller_id === actor.id;
    const isBuyer = order.buyer_id === actor.id;
    if (!isAdmin && !isSeller && !isBuyer) throw new AppError('Not allowed.', 403);
    if (isBuyer && !isSeller && !isAdmin && order.status === 'shipped') {
      throw new AppError('The seller already shipped this order. Message the seller or contact an admin to cancel.');
    }
    const who = isAdmin && !isBuyer && !isSeller ? 'an administrator' : isSeller ? 'the seller' : 'the buyer';
    run(
      "UPDATE orders SET status = 'cancelled', cancel_reason = ?, updated_at = datetime('now') WHERE id = ?",
      `Cancelled by ${who}${reason ? ': ' + reason : ''}`.slice(0, 500), orderId
    );
    adjustBalance(order.buyer_id, order.amount_cents, 'refund', {
      orderId, note: `Refund for "${order.listing_title}"`,
    });
    if (order.listing_id) {
      run("UPDATE listings SET status = 'active', updated_at = datetime('now') WHERE id = ? AND status = 'reserved'", order.listing_id);
    }
    systemMessageForOrder(order, `↩️ Order #${orderId} was cancelled by ${who}. ${formatMoney(order.amount_cents)} was refunded to the buyer.${reason ? ' Reason: ' + reason : ''}`);
    return getOrder(orderId);
  });
}

/* ----------------------------------------------------------------- admin */

function logAdmin(adminId, action, targetType, targetId, note = '') {
  run(
    'INSERT INTO admin_log (admin_id, action, target_type, target_id, note) VALUES (?, ?, ?, ?, ?)',
    adminId, action, targetType, targetId, String(note).slice(0, 1000)
  );
}

function banUser(admin, userId, reason) {
  return transaction(() => {
    const user = get('SELECT * FROM users WHERE id = ?', userId);
    if (!user) throw new AppError('User not found.', 404);
    if (user.id === admin.id) throw new AppError("You can't ban yourself.");
    if (user.role === 'admin') throw new AppError('Remove admin rights before banning this account.');
    run('UPDATE users SET banned = 1, ban_reason = ? WHERE id = ?', reason || 'Violation of marketplace rules', userId);
    // Refund every open order involving the banned user.
    const open = all(
      "SELECT id FROM orders WHERE status IN ('paid','shipped') AND (buyer_id = ? OR seller_id = ?)",
      userId, userId
    );
    for (const o of open) cancelOrder(o.id, admin, 'account suspended');
    // Kill their sessions.
    run("DELETE FROM sessions WHERE json_extract(data, '$.userId') = ?", userId);
    logAdmin(admin.id, 'ban_user', 'user', userId, reason);
    return open.length;
  });
}

function unbanUser(admin, userId) {
  run('UPDATE users SET banned = 0, ban_reason = NULL WHERE id = ?', userId);
  logAdmin(admin.id, 'unban_user', 'user', userId);
}

module.exports = {
  AppError,
  adjustBalance,
  getOrCreateConversation,
  addMessage,
  placeOrder,
  getOrder,
  markShipped,
  confirmReceived,
  cancelOrder,
  logAdmin,
  banUser,
  unbanUser,
};
