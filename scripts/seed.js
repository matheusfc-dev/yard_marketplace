'use strict';
// Populate the database with demo users, listings, chats and orders.
// Usage: npm run seed            (only if there are no listings yet)
//        npm run seed -- --force (add demo data anyway)
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { get, run, transaction } = require('../src/db');
const { ensureAdmin } = require('../src/bootstrap');
const { UPLOAD_DIR } = require('../src/upload');
const svc = require('../src/services');

ensureAdmin();
if (get('SELECT COUNT(*) AS n FROM listings').n > 0 && !process.argv.includes('--force')) {
  console.log('Listings already exist — skipping seed. Use `npm run seed -- --force` to add demo data anyway.');
  process.exit(0);
}

const PASSWORD = 'password123';
const hash = bcrypt.hashSync(PASSWORD, 10);
const people = [
  ['alice', 'Alice Moreno', 'Austin, TX', 'Weekend thrifter. Clearing out the garage one box at a time.'],
  ['ben', 'Ben Carter', 'Portland, OR', 'Cyclist, tinkerer and reluctant minimalist.'],
  ['chloe', 'Chloe Nguyen', 'Denver, CO', 'Moving soon — everything must go!'],
  ['dan', 'Dan Okafor', 'Chicago, IL', 'Collector of vinyl and vintage cameras.'],
];

const COLORS = [['#1f7a4d', '#e4f2e8'], ['#c2412d', '#fbe6e2'], ['#2c5fa8', '#e3eefb'], ['#b7791f', '#fdf0d9'], ['#6b46c1', '#eee7fb'], ['#2f855a', '#e6f4ea']];
const ICONS = {
  'Electronics': '🎧', 'Furniture': '🪑', 'Clothing & Shoes': '👟', 'Home & Garden': '🪴', 'Sports & Outdoors': '🚲',
  'Toys & Games': '🧸', 'Books & Media': '📚', 'Vehicles & Parts': '🛞', 'Tools': '🧰', 'Collectibles': '📷', 'Other': '📦',
};

function esc(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

function makeImage(title, category, variant) {
  const [fg, bg] = COLORS[(title.length + variant) % COLORS.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bg}"/><stop offset="1" stop-color="#ffffff"/></linearGradient></defs>
  <rect width="800" height="600" fill="url(#g)"/>
  <circle cx="${600 - variant * 120}" cy="${140 + variant * 60}" r="170" fill="${fg}" opacity=".10"/>
  <text x="400" y="320" font-size="190" text-anchor="middle" dominant-baseline="middle">${ICONS[category] || '📦'}</text>
  <text x="400" y="520" font-family="system-ui, sans-serif" font-size="40" font-weight="700" fill="${fg}" text-anchor="middle">${esc(title.slice(0, 32))}</text>
</svg>`;
  const name = crypto.randomBytes(16).toString('hex') + '.svg';
  fs.writeFileSync(path.join(UPLOAD_DIR, name), svg);
  return name;
}

const items = [
  ['alice', 'Mid-century oak dresser', 'Furniture', 'Good', 18500, 'Solid oak, six drawers, a few light scratches on top. 48" wide. Pickup only — I can help load.'],
  ['alice', 'KitchenAid stand mixer (red)', 'Home & Garden', 'Like new', 17000, 'Used maybe five times. Comes with dough hook, whisk and paddle.'],
  ['alice', 'Kids balance bike', 'Toys & Games', 'Good', 3500, 'Great first bike for ages 2–4. Adjustable seat.'],
  ['alice', 'Set of 4 terracotta planters', 'Home & Garden', 'New', 4000, 'Never used, still have the tags. Drainage holes included.'],
  ['ben', 'Road bike — 56cm aluminum frame', 'Sports & Outdoors', 'Good', 42000, 'Shimano 105 groupset, new tires and chain this spring. Rides beautifully.'],
  ['ben', 'Cordless drill + 2 batteries', 'Tools', 'Like new', 8500, '18V drill/driver, charger and two 2Ah batteries. Includes carry case.'],
  ['ben', 'Noise-cancelling headphones', 'Electronics', 'Like new', 15000, 'Over-ear, 30h battery. Original box and cable included.'],
  ['ben', 'Camping tent (4-person)', 'Sports & Outdoors', 'Good', 6000, 'Used on three trips, no tears. Packs small.'],
  ['chloe', 'Grey 3-seat sofa', 'Furniture', 'Good', 25000, 'Comfortable, pet-free and smoke-free home. Removable cushion covers.'],
  ['chloe', 'Standing desk frame', 'Furniture', 'Like new', 19000, 'Dual motor, memory presets. Top not included.'],
  ['chloe', 'Leather ankle boots, size 8', 'Clothing & Shoes', 'Like new', 5500, 'Worn twice. Brown leather, side zip.'],
  ['chloe', 'Box of fantasy paperbacks (30)', 'Books & Media', 'Fair', 2500, 'Mixed authors, some well loved. Great for a summer of reading.'],
  ['dan', '35mm film camera', 'Collectibles', 'Good', 13000, 'Fully mechanical, light meter works. Lens has no fungus or haze.'],
  ['dan', 'Vinyl records — jazz lot (20)', 'Books & Media', 'Good', 9000, 'Classic jazz pressings, sleeves in decent shape. Ask for the full list.'],
  ['dan', 'Mechanical keyboard', 'Electronics', 'Like new', 7000, 'Tenkeyless, brown switches, PBT keycaps.'],
  ['dan', 'Set of winter tires 205/55 R16', 'Vehicles & Parts', 'Good', 22000, 'About 60% tread left. Stored indoors.'],
];

transaction(() => {
  const ids = {};
  for (const [username, name, location, bio] of people) {
    const existing = get('SELECT id FROM users WHERE username = ?', username);
    ids[username] = existing ? existing.id : Number(run(
      "INSERT INTO users (username, email, password_hash, display_name, location, bio, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))",
      username, `${username}@example.com`, hash, name, location, bio, `-${30 + Math.floor(Math.random() * 300)} days`
    ).lastInsertRowid);
  }
  const listingIds = [];
  items.forEach(([seller, title, category, condition, price, description], i) => {
    const r = run(
      `INSERT INTO listings (seller_id, title, description, price_cents, category, condition, location, views, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?))`,
      ids[seller], title, description, price, category, condition, people.find((p) => p[0] === seller)[2],
      Math.floor(Math.random() * 120), `-${i * 7 + Math.floor(Math.random() * 6)} hours`
    );
    const lid = Number(r.lastInsertRowid);
    listingIds.push(lid);
    const n = 1 + (i % 3);
    for (let v = 0; v < n; v++) run('INSERT INTO listing_images (listing_id, filename, position) VALUES (?, ?, ?)', lid, makeImage(title, category, v), v);
  });

  // Wallets
  for (const u of ['alice', 'ben', 'chloe', 'dan']) svc.adjustBalance(ids[u], 50000, 'deposit', { note: 'Funds added (demo payment)' });

  // A chat about the road bike
  const bike = get('SELECT * FROM listings WHERE id = ?', listingIds[4]);
  const conv = svc.getOrCreateConversation(bike, ids.alice);
  svc.addMessage(conv.id, ids.alice, 'Hi Ben! Is the road bike still available? What height rider is it for?');
  svc.addMessage(conv.id, ids.ben, 'Hey Alice — yes it is! 56cm fits roughly 5\'8" to 5\'11".');
  svc.addMessage(conv.id, ids.alice, 'Perfect. Could I test ride it this weekend?');

  // A completed sale: Dan buys Chloe's paperbacks
  const order = svc.placeOrder(ids.dan, listingIds[11], 'Can pick up Sunday afternoon.');
  svc.markShipped(order.id, ids.chloe);
  svc.confirmReceived(order.id, ids.dan);

  // An order in escrow: Chloe buys Ben's headphones
  svc.placeOrder(ids.chloe, listingIds[6], 'Please ship to my Denver address, I will send it in chat.');

  // An open report
  run('INSERT INTO reports (listing_id, reporter_id, reason, details) VALUES (?, ?, ?, ?)', listingIds[15], ids.alice, 'Wrong category / spam', 'Posted this same item three times last week.');
});

console.log(`Seeded demo data. Demo users: ${people.map((p) => p[0]).join(', ')} — password: ${PASSWORD}`);
