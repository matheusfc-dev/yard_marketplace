'use strict';
// End-to-end flow test: node --test test/
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yard-test-'));
process.env.DATA_DIR = tmp;
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.ADMIN_PASSWORD = 'admin-test-pass';
const app = require('../src/server');

let server, base;
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

class Client {
  constructor() { this.cookie = ''; this.csrf = ''; }
  async req(method, url, { form, body, json } = {}) {
    const headers = { cookie: this.cookie };
    let payload;
    if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams({ _csrf: this.csrf, ...form }).toString(); }
    if (body) { body.append('_csrf', this.csrf); payload = body; }
    if (json) { headers['content-type'] = 'application/json'; headers['x-csrf-token'] = this.csrf; headers.accept = 'application/json'; payload = JSON.stringify(json); }
    const res = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const text = await res.text();
    const m = text.match(/name="csrf-token" content="([a-f0-9]+)"/);
    if (m) this.csrf = m[1];
    return { status: res.status, location: res.headers.get('location'), text, json: () => JSON.parse(text) };
  }
  get(url) { return this.req('GET', url); }
  post(url, opts) { return this.req('POST', url, opts); }
  async register(username) {
    await this.get('/register');
    const r = await this.post('/register', { form: { username, email: `${username}@test.dev`, display_name: username, password: 'password123', password_confirm: 'password123' } });
    assert.equal(r.status, 302, r.text.slice(0, 500));
    await this.get('/');
  }
}

const balanceOf = (html) => html.match(/class="navlink wallet-link[^"]*"[^>]*>\$([\d,.]+)/)[1];

test('full marketplace flow', async () => {
  const seller = new Client(), buyer = new Client(), admin = new Client();
  await seller.register('sally');
  await buyer.register('bob');

  // CSRF is enforced
  const noCsrf = await fetch(base + '/wallet/deposit', { method: 'POST', headers: { cookie: buyer.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'amount=10', redirect: 'manual' });
  assert.equal(noCsrf.status, 403);

  // Seller posts listing with a photo
  const fd = new FormData();
  for (const [k, v] of Object.entries({ title: 'Vintage bike', description: 'A lovely old bike in good shape.', price: '120.50', category: 'Sports & Outdoors', condition: 'Good', location: 'Austin' })) fd.append(k, v);
  fd.append('images', new Blob([PNG], { type: 'image/png' }), 'bike.png');
  const created = await seller.post('/listings', { body: fd });
  assert.equal(created.status, 302, created.text.slice(0, 300));
  const listingUrl = created.location;
  const listingId = Number(listingUrl.split('/').pop());

  // Fake image is rejected
  const bad = new FormData();
  for (const [k, v] of Object.entries({ title: 'Bad', description: 'not an image at all', price: '1', category: 'Other', condition: 'Good' })) bad.append(k, v);
  bad.append('images', new Blob(['<script>'], { type: 'image/png' }), 'x.png');
  const badRes = await seller.post('/listings', { body: bad });
  assert.equal(badRes.status, 400);

  // Visible on home & search
  assert.match((await buyer.get('/?q=bike')).text, /Vintage bike/);

  // Buyer messages seller
  const contact = await buyer.post(`/listings/${listingId}/contact`, { form: { body: 'Is it available?' } });
  const convId = Number(contact.location.split('/').pop());
  const sent = await buyer.post(`/api/conversations/${convId}/messages`, { json: { body: 'Can I pick up Saturday?' } });
  assert.equal(sent.status, 201);
  await seller.get('/');
  const msgs = (await seller.get(`/api/conversations/${convId}/messages`)).json();
  assert.equal(msgs.messages.length, 2);
  // Third party can't read it
  const eve = new Client(); await eve.register('eve');
  assert.equal((await eve.get(`/api/conversations/${convId}/messages`)).status, 404);

  // Buying without funds fails, then deposit and buy
  await buyer.get('/');
  let r = await buyer.post(`/listings/${listingId}/buy`, { form: {} });
  assert.match(r.location, /\/wallet\?need=/);
  await buyer.get('/wallet');
  await buyer.post('/wallet/deposit', { form: { amount: '200' } });
  await buyer.get('/');
  r = await buyer.post(`/listings/${listingId}/buy`, { form: { shipping_note: 'Pickup Saturday' } });
  assert.match(r.location, /^\/orders\/\d+$/);
  const orderId = Number(r.location.split('/').pop());
  assert.equal(balanceOf((await buyer.get('/')).text), '79.50');

  // Can't buy twice
  const second = new Client(); await second.register('carl');
  await second.post('/wallet/deposit', { form: { amount: '500' } }); await second.get('/');
  r = await second.post(`/listings/${listingId}/buy`, { form: {} });
  assert.equal(r.location, `/listings/${listingId}`);

  // Buyer can't mark shipped; seller ships; buyer confirms
  await buyer.post(`/orders/${orderId}/ship`, { form: {} });
  assert.match((await buyer.get(`/orders/${orderId}`)).text, /Paid · in escrow/);
  await seller.get('/');
  await seller.post(`/orders/${orderId}/ship`, { form: {} });
  await buyer.get('/');
  await buyer.post(`/orders/${orderId}/confirm`, { form: {} });
  const sellerHome = await seller.get('/');
  assert.equal(balanceOf(sellerHome.text), '120.50');
  assert.match((await seller.get(`/listings/${listingId}`)).text, /This item has been sold|Sold/);

  // System messages were added to the chat
  const after = (await buyer.get(`/api/conversations/${convId}/messages`)).json();
  assert.ok(after.messages.filter((m) => m.is_system).length >= 3);

  // Admin: login, report flow, remove listing, ban user
  await admin.get('/login');
  r = await admin.post('/login', { form: { login: 'admin', password: 'admin-test-pass', next: '/admin' } });
  assert.equal(r.location, '/admin');
  assert.equal((await admin.get('/admin')).status, 200);
  assert.equal((await buyer.get('/admin')).status, 403);

  // Seller posts a second listing, eve reports it, admin removes it
  const fd2 = new FormData();
  for (const [k, v] of Object.entries({ title: 'Suspicious watch', description: 'Totally real designer watch.', price: '20', category: 'Collectibles', condition: 'New' })) fd2.append(k, v);
  fd2.append('images', new Blob([PNG], { type: 'image/png' }), 'w.png');
  await seller.get('/listings/new');
  const l2 = Number((await seller.post('/listings', { body: fd2 })).location.split('/').pop());
  await eve.get(`/listings/${l2}`);
  await eve.post(`/listings/${l2}/report`, { form: { reason: 'Counterfeit', details: 'fake' } });
  assert.match((await admin.get('/admin/reports')).text, /Suspicious watch/);
  await admin.post(`/admin/listings/${l2}/remove`, { form: { reason: 'Counterfeit goods' } });
  assert.equal((await eve.get(`/listings/${l2}`)).status, 404);
  assert.match((await seller.get('/dashboard')).text, /Counterfeit goods/);

  // Open order is refunded when a user is banned
  const fd3 = new FormData();
  for (const [k, v] of Object.entries({ title: 'Lamp', description: 'Nice desk lamp works.', price: '30', category: 'Home & Garden', condition: 'Good' })) fd3.append(k, v);
  fd3.append('images', new Blob([PNG], { type: 'image/png' }), 'l.png');
  await seller.get('/');
  const l3 = Number((await seller.post('/listings', { body: fd3 })).location.split('/').pop());
  await buyer.get('/');
  await buyer.post(`/listings/${l3}/buy`, { form: {} });
  assert.equal(balanceOf((await buyer.get('/')).text), '49.50');

  const sellerId = Number((await admin.get('/admin/users?q=sally')).text.match(/\/admin\/users\/(\d+)/)[1]);
  await admin.get('/admin');
  await admin.post(`/admin/users/${sellerId}/ban`, { form: { reason: 'Selling counterfeits' } });
  assert.equal(balanceOf((await buyer.get('/')).text), '79.50');

  // Banned seller is logged out and can't log in
  r = await seller.get('/dashboard');
  assert.match(r.location, /^\/login/);
  const s2 = new Client(); await s2.get('/login');
  r = await s2.post('/login', { form: { login: 'sally', password: 'password123' } });
  assert.equal(r.status, 403);
  assert.match(r.text, /suspended/);
  // Their listings are hidden
  assert.doesNotMatch((await buyer.get('/')).text, /Lamp/);

  // Unban restores access
  await admin.get('/admin');
  await admin.post(`/admin/users/${sellerId}/unban`, { form: {} });
  await s2.get('/login');
  r = await s2.post('/login', { form: { login: 'sally', password: 'password123' } });
  assert.equal(r.status, 302);
});
