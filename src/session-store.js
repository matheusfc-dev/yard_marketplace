'use strict';
const session = require('express-session');
const { get, run } = require('./db');

/** Minimal express-session store backed by the app's SQLite database. */
class SqliteStore extends session.Store {
  constructor() {
    super();
    this.timer = setInterval(() => run('DELETE FROM sessions WHERE expires < ?', Date.now()), 15 * 60 * 1000);
    this.timer.unref();
  }

  expiry(sess) {
    const maxAge = sess?.cookie?.maxAge;
    return Date.now() + (typeof maxAge === 'number' ? maxAge : 86400000);
  }

  get(sid, cb) {
    try {
      const row = get('SELECT data, expires FROM sessions WHERE sid = ?', sid);
      if (!row || row.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.data));
    } catch (e) { cb(e); }
  }

  set(sid, sess, cb) {
    try {
      run(
        `INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires`,
        sid, JSON.stringify(sess), this.expiry(sess)
      );
      cb && cb(null);
    } catch (e) { cb && cb(e); }
  }

  touch(sid, sess, cb) {
    try {
      run('UPDATE sessions SET expires = ? WHERE sid = ?', this.expiry(sess), sid);
      cb && cb(null);
    } catch (e) { cb && cb(e); }
  }

  destroy(sid, cb) {
    try {
      run('DELETE FROM sessions WHERE sid = ?', sid);
      cb && cb(null);
    } catch (e) { cb && cb(e); }
  }
}

module.exports = SqliteStore;
