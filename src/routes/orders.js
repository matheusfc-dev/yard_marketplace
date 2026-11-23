'use strict';
const express = require('express');
const { get, all } = require('../db');
const { str, intParam } = require('../util');
const { requireAuth } = require('../middleware');
const svc = require('../services');

const router = express.Router();

function visibleOrder(req) {
  const order = svc.getOrder(intParam(req.params.id));
  if (!order) throw new svc.AppError('Order not found.', 404);
  if (order.buyer_id !== req.user.id && order.seller_id !== req.user.id && req.user.role !== 'admin') {
    throw new svc.AppError('Order not found.', 404);
  }
  return order;
}

router.get('/listings/:id/buy', requireAuth, (req, res) => {
  const listing = get(
    `SELECT l.*, u.display_name, u.username, u.banned,
            (SELECT filename FROM listing_images i WHERE i.listing_id = l.id ORDER BY position, id LIMIT 1) AS cover
       FROM listings l JOIN users u ON u.id = l.seller_id WHERE l.id = ?`,
    intParam(req.params.id)
  );
  if (!listing || listing.status !== 'active' || listing.banned) throw new svc.AppError('This item is no longer available.', 404);
  if (listing.seller_id === req.user.id) throw new svc.AppError("You can't buy your own listing.");
  res.render('orders/checkout', { title: 'Checkout', listing });
});

router.post('/listings/:id/buy', requireAuth, (req, res) => {
  const listingId = intParam(req.params.id);
  try {
    const order = svc.placeOrder(req.user.id, listingId, str(req.body.shipping_note, 1000));
    req.flash('success', 'Payment complete! Your money is held in escrow until you confirm you received the item.');
    res.redirect(`/orders/${order.id}`);
  } catch (e) {
    if (!(e instanceof svc.AppError)) throw e;
    req.flash('error', e.message);
    res.redirect(e.message.includes('balance') ? `/wallet?need=${listingId}` : `/listings/${listingId}`);
  }
});

router.get('/orders', requireAuth, (req, res) => {
  const tab = req.query.tab === 'sales' ? 'sales' : 'purchases';
  const col = tab === 'sales' ? 'seller_id' : 'buyer_id';
  const orders = all(
    `SELECT o.*, b.display_name AS buyer_name, b.username AS buyer_username,
            s.display_name AS seller_name, s.username AS seller_username,
            (SELECT filename FROM listing_images i WHERE i.listing_id = o.listing_id ORDER BY position, id LIMIT 1) AS cover
       FROM orders o JOIN users b ON b.id = o.buyer_id JOIN users s ON s.id = o.seller_id
      WHERE o.${col} = ? ORDER BY o.id DESC`,
    req.user.id
  );
  const counts = get(
    `SELECT (SELECT COUNT(*) FROM orders WHERE buyer_id = ? AND status IN ('paid','shipped')) AS buying,
            (SELECT COUNT(*) FROM orders WHERE seller_id = ? AND status IN ('paid','shipped')) AS selling`,
    req.user.id, req.user.id
  );
  res.render('orders/index', { title: 'Orders', orders, tab, counts });
});

router.get('/orders/:id', requireAuth, (req, res) => {
  const order = visibleOrder(req);
  const cover = order.listing_id
    ? get('SELECT filename FROM listing_images WHERE listing_id = ? ORDER BY position, id LIMIT 1', order.listing_id)?.filename
    : null;
  const conversation = order.listing_id
    ? get('SELECT id FROM conversations WHERE listing_id = ? AND buyer_id = ?', order.listing_id, order.buyer_id)
    : null;
  res.render('orders/show', { title: `Order #${order.id}`, order, cover, conversation });
});

function action(fn, successMsg) {
  return (req, res) => {
    const order = visibleOrder(req);
    try {
      fn(order, req);
      req.flash('success', successMsg);
    } catch (e) {
      if (!(e instanceof svc.AppError)) throw e;
      req.flash('error', e.message);
    }
    res.redirect(req.body.back === 'admin' && req.user.role === 'admin' ? '/admin/orders' : `/orders/${order.id}`);
  };
}

router.post('/orders/:id/ship', requireAuth, action((o, req) => svc.markShipped(o.id, req.user.id), 'Marked as shipped. The buyer has been notified.'));
router.post('/orders/:id/confirm', requireAuth, action((o, req) => svc.confirmReceived(o.id, req.user.id), 'Thanks! The payment was released to the seller.'));
router.post('/orders/:id/cancel', requireAuth, action((o, req) => {
  svc.cancelOrder(o.id, req.user, str(req.body.reason, 300));
  if (req.user.role === 'admin' && o.buyer_id !== req.user.id && o.seller_id !== req.user.id) {
    svc.logAdmin(req.user.id, 'refund_order', 'order', o.id, str(req.body.reason, 300));
  }
}, 'Order cancelled and the buyer was refunded.'));

module.exports = router;
