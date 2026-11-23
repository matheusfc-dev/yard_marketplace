'use strict';

const CATEGORIES = [
  'Electronics', 'Furniture', 'Clothing & Shoes', 'Home & Garden', 'Sports & Outdoors',
  'Toys & Games', 'Books & Media', 'Vehicles & Parts', 'Tools', 'Collectibles', 'Other',
];
const CONDITIONS = ['New', 'Like new', 'Good', 'Fair', 'For parts'];

function formatMoney(cents) {
  const n = Number(cents || 0) / 100;
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Parse "12", "12.5", "$1,234.56" into integer cents, or null if invalid. */
function parseMoney(input) {
  if (input === undefined || input === null) return null;
  const s = String(input).replace(/[$,\s]/g, '');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
}

function toDate(sqliteDate) {
  if (!sqliteDate) return null;
  return new Date(String(sqliteDate).replace(' ', 'T') + 'Z');
}

function timeAgo(sqliteDate) {
  const d = toDate(sqliteDate);
  if (!d) return '';
  const s = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (s < 60) return 'just now';
  const units = [['y', 31536000], ['mo', 2592000], ['w', 604800], ['d', 86400], ['h', 3600], ['m', 60]];
  for (const [u, sec] of units) {
    if (s >= sec) return `${Math.floor(s / sec)}${u} ago`;
  }
  return 'just now';
}

function formatDate(sqliteDate) {
  const d = toDate(sqliteDate);
  if (!d) return '';
  return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

function str(v, max = 10000) {
  return (typeof v === 'string' ? v : '').trim().slice(0, max);
}

function intParam(v, fallback = null) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const ORDER_STATUS_LABEL = {
  paid: 'Paid · in escrow',
  shipped: 'Shipped',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

module.exports = {
  CATEGORIES, CONDITIONS, ORDER_STATUS_LABEL,
  formatMoney, parseMoney, timeAgo, formatDate, toDate, str, intParam,
};
