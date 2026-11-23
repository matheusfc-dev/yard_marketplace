# Yard Marketplace

A complete second-hand marketplace web app: people sign up, post items for sale, chat with buyers, and pay **inside the site** through a wallet with escrow protection. Admin accounts moderate listings, handle reports, refund orders and ban users.

Stack: **Node.js 22.13+** (uses the built-in `node:sqlite`), Express 5, EJS server-rendered pages, SQLite. No build step and no external database.

## Quick start

```bash
npm install
npm run seed     # optional: demo users, listings, chats and orders
npm start        # http://localhost:3000
```

On first start an **admin account** is created automatically and its password is printed in the console.
To choose the credentials yourself, set them before the first start:

```bash
ADMIN_USERNAME=admin ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-strong-password' npm start
```

Demo users created by `npm run seed`: `alice`, `ben`, `chloe`, `dan` — password `password123`.

To reset everything, stop the server and delete `data/` and the files in `uploads/`.

## Features

**Everyone**
- Browse, search, filter by category / price / condition, sort, paginate
- Listing pages with photo gallery, seller info and "more from this seller"
- Public seller profiles

**Signed-in users**
- Register / sign in / sign out, profile and password settings
- Post listings with up to 8 photos (JPG/PNG/WEBP/GIF, 5 MB each, file signatures verified), edit, mark sold, relist, delete
- Save favourite items
- Message sellers from any listing — inbox with unread badges, live updates (polling), read receipts
- **Wallet + escrow checkout**
  1. Buyer pays from their wallet → money is held in escrow, listing shows "Pending sale"
  2. Seller marks the order shipped / handed over
  3. Buyer confirms receipt → money is released to the seller's wallet
  - Seller can cancel any time before completion; buyer can cancel before shipping → automatic full refund
  - Every step posts a system message in the buyer/seller chat
  - Full wallet transaction history with running balance; deposit and withdraw
- Report listings (reason + details)
- Seller dashboard: views, saves, chats, earnings, funds in escrow

**Admins** (`/admin`)
- Overview stats and a 14-day chart of new listings
- Reports queue: remove listing, ban seller, or dismiss
- Listings: search/filter, remove with a reason (seller sees it), restore, delete permanently
- Users: search, ban with reason / unban, promote to or demote from admin, adjust wallet balance (logged)
- Orders: view all, refund any open order
- Moderation log of every admin action
- Banning a user signs them out immediately, hides their listings and refunds all their open orders

## Security

- Passwords hashed with bcrypt (cost 12); login is constant-time for unknown users; rate-limited auth
- Sessions stored in SQLite, `httpOnly` + `SameSite=Lax` cookies, session ID regenerated on login
- CSRF token on every state-changing request
- Strict Content-Security-Policy and other headers via Helmet (no inline scripts or styles)
- Parameterised SQL everywhere; all output escaped by EJS
- Upload type/size limits and magic-byte verification, random file names
- Money stored as integer cents; balance changes happen in DB transactions with a `balance >= 0` constraint

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `NODE_ENV` | – | `production` enables long static caching |
| `TRUST_PROXY` | – | Set to `1` behind a reverse proxy (nginx, Caddy…) so secure cookies and client IPs work |
| `SESSION_SECRET` | auto | Otherwise a random secret is generated once and kept in `data/.session-secret` |
| `DATA_DIR` | `./data` | Where the SQLite database lives |
| `UPLOAD_DIR` | `./uploads` | Where listing photos are stored |
| `ADMIN_USERNAME` / `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `admin` / `admin@yard.local` / random | First admin account (only used when no admin exists) |

## Going to production

- **Real payments.** Wallet deposits and withdrawals are *simulated* (`src/routes/wallet.js`), and the site says so. To take real money, replace the deposit handler with a payment provider checkout (e.g. Stripe Checkout) that calls `adjustBalance(userId, amount, 'deposit')` from a verified webhook, and route withdrawals to payouts (e.g. Stripe Connect). Escrow, orders and refunds already work on top of the wallet ledger.
- Run behind HTTPS with `NODE_ENV=production TRUST_PROXY=1`.
- Back up `data/yard.db` and `uploads/`.
- Optional additions: email verification and password reset (needs an email provider), image resizing, WebSockets instead of polling.

## Project layout

```
src/
  server.js          app setup, security headers, error handling
  db.js              SQLite schema + helpers
  services.js        wallet ledger, orders/escrow, conversations, bans
  middleware.js      auth, CSRF, flash messages, rate limiting
  routes/            auth, listings, messages, orders, wallet, users, admin
views/               EJS templates (admin/ for the admin panel)
public/              CSS, JS (chat, UI helpers), logo
scripts/seed.js      demo data
test/e2e.test.js     end-to-end test of the whole buy/sell/moderate flow (npm test)
```
