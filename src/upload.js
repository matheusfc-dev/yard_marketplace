'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const multer = require('multer');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const MAX_IMAGES = 8;

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + TYPES[file.mimetype]),
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: MAX_IMAGES, fields: 30 },
  fileFilter: (req, file, cb) => cb(null, Boolean(TYPES[file.mimetype])),
});

/** Verify file signatures so renamed non-images are rejected. Returns the valid files; deletes the rest. */
function keepRealImages(files = []) {
  const ok = [];
  for (const f of files) {
    let valid = false;
    try {
      const fd = fs.openSync(f.path, 'r');
      const b = Buffer.alloc(12);
      fs.readSync(fd, b, 0, 12, 0);
      fs.closeSync(fd);
      valid =
        (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) ||                           // JPEG
        b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) || // PNG
        b.subarray(0, 4).toString() === 'GIF8' ||                                       // GIF
        (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP'); // WEBP
    } catch { valid = false; }
    if (valid) ok.push(f);
    else removeFile(f.filename);
  }
  return ok;
}

function removeFile(filename) {
  if (!filename || filename.includes('/') || filename.includes('..')) return;
  fs.unlink(path.join(UPLOAD_DIR, filename), () => {});
}

module.exports = { upload, keepRealImages, removeFile, MAX_IMAGES, UPLOAD_DIR };
