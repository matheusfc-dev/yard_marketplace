'use strict';
const express = require('express');
const { get, all } = require('../db');
const { parseMoney, intParam } = require('../util');
const { requireAuth, rateLimit } = require('../middleware');
const { adjustBalance, AppError } = require('../services');

const router = express.Router();
const walletLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 });
const MAX_DEPOSIT = 1_000_000; // $10,000 per deposit

router.get('/wallet', requireAuth, (req, res) => {
  const txs = all('SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY id DESC LIMIT 100', req.user.id);
  const escrow = get(
    "SELECT COALESCE(SUM(amount_cents),0) AS held FROM orders WHERE buyer_id = ? AND status IN ('paid','shipped')",
    req.user.id
  ).held;
  const incoming = get(
    "SELECT COALESCE(SUM(amount_cents),0) AS n FROM orders WHERE seller_id = ? AND status IN ('paid','shipped')",
    req.user.id
  ).n;
  const need = intParam(req.query.need)
    ? get("SELECT id, title, price_cents FROM listings WHERE id = ? AND status = 'active'", intParam(req.query.need))
    : null;
  res.render('wallet', { title: 'Wallet', txs, escrow, incoming, need });
});

router.post('/wallet/deposit', requireAuth, walletLimiter, (req, res) => {
  const amount = parseMoney(req.body.amount);
  if (!amount || amount < 100 || amount > MAX_DEPOSIT) throw new AppError('Deposit between $1.00 and $10,000.00.');
  adjustBalance(req.user.id, amount, 'deposit', { note: 'Funds added (demo payment)' });
  req.flash('success', 'Funds added to your wallet.');
  const need = intParam(req.body.need);
  res.redirect(need ? `/listings/${need}/buy` : '/wallet');
});

router.post('/wallet/withdraw', requireAuth, walletLimiter, (req, res) => {
  const amount = parseMoney(req.body.amount);
  if (!amount || amount < 100) throw new AppError('Withdraw at least $1.00.');
  adjustBalance(req.user.id, -amount, 'withdrawal', { note: 'Withdrawal to bank account (demo payout)' });
  req.flash('success', 'Withdrawal requested.');
  res.redirect('/wallet');
});

module.exports = router;
