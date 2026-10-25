const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { ipKeyGenerator } = require('express-rate-limit');
const avatarFileStorage = require('../services/avatar-storage');
const { auth } = require('../middleware/auth');
const { pool } = require('../config/database');
const router = express.Router();

const { AVATAR_DIR, UPLOAD_BASE } = avatarFileStorage;
avatarFileStorage.ensureUploadDirs();
const POST_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const POST_VIDEO_MAX_BYTES = 50 * 1024 * 1024;
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp']
]);
const VIDEO_TYPES = new Map([
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.ogv', 'video/ogg']
]);

function createUploadLimiter({ windowMs, max, keyGenerator, message }) {
  const entries = new Map();
  let lastCleanup = 0;
  return function(req, res, next) {
    const now = Date.now();
    if (entries.size > 50000 || now - lastCleanup >= 60000) {
      for (const [entryKey, entry] of entries) {
        if (entry.resetAt <= now || entries.size > 50000) entries.delete(entryKey);
      }
      lastCleanup = now;
    }
    const key = keyGenerator(req);
    let entry = entries.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      entries.set(key, entry);
    }
    entry.count = Math.min(max + 1, entry.count + 1);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    res.setHeader('RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));
    if (entry.count > max) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))));
      return res.status(429).json({ code: 429, message });
    }
    return next();
  };
}

const uploadIpLimiter = createUploadLimiter({
  windowMs: 15 * 60 * 1000,
  max: 120,
  keyGenerator: function(req) { return ipKeyGenerator(req.ip || req.socket.remoteAddress || 'unknown'); },
  message: '上传请求过多，请15分钟后再试'
});
const uploadUserLimiter = createUploadLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  keyGenerator: function(req) { return String(req.user && req.user.id || 'unknown'); },
  message: '账号上传次数过多，请15分钟后再试'
});

function getSafeImageExtension(file) {
  if (!file || typeof file.originalname !== 'string') return null;
  if (file.originalname.length > 255 || /[\u0000-\u001f\u007f]/.test(file.originalname)) return null;
  if (/[\\/]/.test(file.originalname)) return null;
  const extension = path.extname(file.originalname).toLowerCase();
  return IMAGE_TYPES.has(extension) ? extension : null;
}

function imageFileFilter(req, file, cb) {
  const extension = getSafeImageExtension(file);
  const mimeType = typeof file.mimetype === 'string' ? file.mimetype.toLowerCase() : '';
  const expectedMimeType = extension && IMAGE_TYPES.get(extension);
  if (!extension || (mimeType && mimeType !== 'application/octet-stream' && mimeType !== expectedMimeType)) {
    return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
  }
  cb(null, true);
}

function getSafeVideoExtension(file) {
  if (!file || typeof file.originalname !== 'string') return null;
  if (file.originalname.length > 255 || /[\u0000-\u001f\u007f]/.test(file.originalname)) return null;
  if (/[\\/]/.test(file.originalname)) return null;
  const extension = path.extname(file.originalname).toLowerCase();
  return VIDEO_TYPES.has(extension) ? extension : null;
}

function videoFileFilter(req, file, cb) {
  const extension = getSafeVideoExtension(file);
  const mimeType = typeof file.mimetype === 'string' ? file.mimetype.toLowerCase() : '';
  const expectedMimeType = extension && VIDEO_TYPES.get(extension);
  if (!extension || (mimeType && mimeType !== 'application/octet-stream' && mimeType !== expectedMimeType)) {
    return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
  }
  cb(null, true);
}

function createImageStorage(directory, prefix) {
  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, directory),
    filename: (req, file, cb) => {
      const extension = getSafeImageExtension(file);
      if (!extension) return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
      cb(null, `${prefix}_${Date.now()}_${crypto.randomBytes(12).toString('hex')}${extension}`);
    }
  });
}

function createPostVideoStorage() {
  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, file.fieldname === 'poster' ? path.join(UPLOAD_BASE, 'posts') : path.join(UPLOAD_BASE, 'videos')),
    filename: (req, file, cb) => {
      const extension = file.fieldname === 'poster' ? getSafeImageExtension(file) : getSafeVideoExtension(file);
      if (!extension) return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
      const prefix = file.fieldname === 'poster' ? 'post' : 'video';
      cb(null, `${prefix}_${Date.now()}_${crypto.randomBytes(12).toString('hex')}${extension}`);
    }
  });
}

function postVideoFileFilter(req, file, cb) {
  if (file.fieldname === 'poster') return imageFileFilter(req, file, cb);
  if (file.fieldname === 'video') return videoFileFilter(req, file, cb);
  return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
}

function resolveStoredAvatarPaths(avatar) {
  return avatarFileStorage.resolveStoredAvatarPaths(avatar);
}

function removeAvatarFile(filePath, reason) {
  return avatarFileStorage.removeStoredFile(filePath, reason);
}

const postStorage = createImageStorage(path.join(UPLOAD_BASE, 'posts'), 'post');
const postUpload = multer({
  storage: postStorage,
  limits: { fileSize: POST_IMAGE_MAX_BYTES, files: 9, fields: 10, fieldNameSize: 100, fieldSize: 1024 * 1024, parts: 20 },
  fileFilter: imageFileFilter
});
const videoUpload = multer({
  storage: createPostVideoStorage(),
  limits: { fileSize: POST_VIDEO_MAX_BYTES, files: 2, fields: 4, fieldNameSize: 100, fieldSize: 1024 * 1024, parts: 6 },
  fileFilter: postVideoFileFilter
});

const avatarDiskStorage = createImageStorage(AVATAR_DIR, 'avatar');
const avatarUpload = multer({
  storage: avatarDiskStorage,
  limits: { fileSize: AVATAR_MAX_BYTES, files: 1, fields: 4, fieldNameSize: 100, fieldSize: 1024 * 1024, parts: 5 },
  fileFilter: imageFileFilter
});

function removeUploadedFiles(files) {
  const list = Array.isArray(files)
    ? files
    : Object.keys(files || {}).reduce(function(all, key) { return all.concat(files[key] || []); }, []);
  list.forEach(function(file) {
    if (file && file.path) avatarFileStorage.removeStoredFile(file.path, '回收上传临时文件');
  });
}

function sendUploadMiddlewareError(res, err, mediaType) {
  if (err) console.error('[上传校验失败]', err.code || err.message || 'unknown error');
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.json({ code: 400, message: '文件超过限制大小' });
  }
  return res.json({ code: 400, message: mediaType === 'video' ? '视频格式或上传参数不正确' : '图片格式或上传参数不正确' });
}

async function validateVideoFile(filePath, maxBytes) {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) return false;
    const handle = await fs.promises.open(filePath, 'r');
    try {
      const header = Buffer.alloc(16);
      const result = await handle.read(header, 0, header.length, 0);
      if (result.bytesRead < 8) return false;
      const ascii = header.toString('ascii');
      return ascii.slice(4, 8) === 'ftyp' || header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) || ascii.slice(0, 4) === 'OggS';
    } finally {
      await handle.close();
    }
  } catch (err) {
    return false;
  }
}

async function handlePostImagesUpload(req, res) {
  try {
    if (!req.files || req.files.length === 0) {
      return res.json({ code: 400, message: '请选择图片' });
    }
    for (const file of req.files) {
      if (!await avatarFileStorage.validateImageFile(file.path, { maxBytes: POST_IMAGE_MAX_BYTES })) {
        removeUploadedFiles(req.files);
        return res.json({ code: 400, message: '图片内容无效，请重新选择图片' });
      }
    }
    const ts = Date.now();
    const paths = req.files.map(f => `/uploads/posts/${f.filename}?t=${ts}`);
    res.json({ code: 200, message: '上传成功', data: { images: paths } });
  } catch (err) {
    console.error('上传失败:', err.message);
    res.json({ code: 500, message: '上传失败，请稍后重试' });
  }
}

function handlePostImagesUploadRequest(req, res) {
  postUpload.array('images', 9)(req, res, function(err) {
    if (err) {
      removeUploadedFiles(req.files);
      return sendUploadMiddlewareError(res, err);
    }
    return handlePostImagesUpload(req, res);
  });
}

router.post('/post-images', auth, uploadIpLimiter, uploadUserLimiter, handlePostImagesUploadRequest);

async function handlePostVideoUpload(req, res) {
  try {
    const videoFile = req.files && req.files.video && req.files.video[0];
    const posterFile = req.files && req.files.poster && req.files.poster[0];
    if (!videoFile) return res.json({ code: 400, message: '请选择视频' });
    if (!await validateVideoFile(videoFile.path, POST_VIDEO_MAX_BYTES)) {
      removeUploadedFiles([videoFile, posterFile]);
      return res.json({ code: 400, message: '视频内容无效，请重新选择视频' });
    }
    if (posterFile && !await avatarFileStorage.validateImageFile(posterFile.path, { maxBytes: POST_IMAGE_MAX_BYTES })) {
      removeUploadedFiles([videoFile, posterFile]);
      return res.json({ code: 400, message: '视频封面无效，请重新选择视频' });
    }
    const video = `/uploads/videos/${videoFile.filename}`;
    const poster = posterFile ? `/uploads/posts/${posterFile.filename}` : null;
    return res.json({ code: 200, message: '视频上传成功', data: { video, poster } });
  } catch (err) {
    removeUploadedFiles([req.files && req.files.video && req.files.video[0], req.files && req.files.poster && req.files.poster[0]]);
    console.error('视频上传失败:', err.message);
    return res.json({ code: 500, message: '视频上传失败，请稍后重试' });
  }
}

function handlePostVideoUploadRequest(req, res) {
  videoUpload.fields([{ name: 'video', maxCount: 1 }, { name: 'poster', maxCount: 1 }])(req, res, function(err) {
    if (err) {
      removeUploadedFiles(req.files);
      return sendUploadMiddlewareError(res, err, 'video');
    }
    return handlePostVideoUpload(req, res);
  });
}

router.post('/post-video', auth, uploadIpLimiter, uploadUserLimiter, handlePostVideoUploadRequest);

async function handleAvatarUpload(req, res) {
  try {
    if (!req.file) {
      return res.json({ code: 400, message: '请选择图片' });
    }
    if (!await avatarFileStorage.validateImageFile(req.file.path, { maxBytes: AVATAR_MAX_BYTES })) {
      avatarFileStorage.removeStoredFile(req.file.path, '回收无效头像');
      return res.json({ code: 400, message: '图片内容无效，请重新选择图片' });
    }

    let existingFilename = await avatarFileStorage.findExistingAvatar(req.file.path);
    let selectedFilename = existingFilename || req.file.filename;
    let selectedFilePath = path.join(AVATAR_DIR, selectedFilename);
    try {
      const selectedStat = await fs.promises.stat(selectedFilePath);
      if (!selectedStat.isFile()) throw new Error('头像不是普通文件');
    } catch (err) {
      existingFilename = null;
      selectedFilename = req.file.filename;
      selectedFilePath = path.join(AVATAR_DIR, selectedFilename);
    }
    if (existingFilename) {
      avatarFileStorage.removeStoredFile(req.file.path, '回收重复头像');
    }
    const avatarPath = `/uploads/avatars/${selectedFilename}`;
    let oldAvatar;
    try {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [users] = await connection.execute('SELECT avatar FROM users WHERE id = ? FOR UPDATE', [req.user.id]);
        if (users.length === 0) {
          await connection.rollback();
          if (!existingFilename) removeAvatarFile(req.file.path, '回收不存在用户的新头像');
          return res.json({ code: 404, message: '用户不存在' });
        }
        oldAvatar = users[0].avatar;
        await connection.execute('UPDATE users SET avatar = ? WHERE id = ?', [avatarPath, req.user.id]);
        await connection.commit();
      } catch (transactionError) {
        try { await connection.rollback(); } catch (rollbackError) {}
        throw transactionError;
      } finally {
        connection.release();
      }
    } catch (dbError) {
      if (!existingFilename) removeAvatarFile(req.file.path, '回收数据库更新失败的新头像');
      throw dbError;
    }

    await removeUnreferencedAvatar(oldAvatar, selectedFilePath);

    res.json({ code: 200, message: '上传成功', data: { avatar: avatarPath } });
  } catch (err) {
    console.error('头像上传失败:', err.message);
    res.json({ code: 500, message: '上传失败，请稍后重试' });
  }
}

async function removeUnreferencedAvatar(avatar, protectedFilePath) {
  const oldAvatarPaths = resolveStoredAvatarPaths(avatar);
  if (!oldAvatarPaths.length) return;
  const pathname = String(avatar).split('?')[0];
  const filename = path.basename(pathname);
  const canonicalPath = `/uploads/avatars/${filename}`;
  try {
    const [references] = await pool.execute(
      "SELECT id FROM users WHERE SUBSTRING_INDEX(COALESCE(avatar, ''), '?', 1) = ? LIMIT 1",
      [canonicalPath]
    );
    if (references.length > 0) {
      return;
    }
  } catch (err) {
    console.warn('检查旧头像引用失败，暂不删除:', err.message);
    return;
  }
  oldAvatarPaths.forEach(function(oldAvatarPath) {
    if (path.resolve(oldAvatarPath) !== path.resolve(protectedFilePath)) {
      removeAvatarFile(oldAvatarPath, '删除未引用旧头像');
    }
  });
}

function handleAvatarUploadRequest(req, res) {
  avatarUpload.single('avatar')(req, res, function(err) {
    if (err) {
      removeUploadedFiles(req.file ? [req.file] : req.files);
      return sendUploadMiddlewareError(res, err);
    }
    return handleAvatarUpload(req, res);
  });
}

router.post('/avatar', auth, uploadIpLimiter, uploadUserLimiter, handleAvatarUploadRequest);

module.exports = router;
module.exports.avatarUpload = avatarUpload;
module.exports.handleAvatarUpload = handleAvatarUpload;
module.exports.handleAvatarUploadRequest = handleAvatarUploadRequest;
module.exports.getSafeImageExtension = getSafeImageExtension;
module.exports.imageFileFilter = imageFileFilter;
module.exports.getSafeVideoExtension = getSafeVideoExtension;
module.exports.videoFileFilter = videoFileFilter;
module.exports.validateVideoFile = validateVideoFile;
module.exports.uploadIpLimiter = uploadIpLimiter;
module.exports.uploadUserLimiter = uploadUserLimiter;
