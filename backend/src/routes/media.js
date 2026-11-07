import fs from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { ApiError, notFound, validationError } from '../errors.js';
import { newId, nowIso, requireEnum } from '../util.js';

const AUDIO_TYPES = {
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/aac': 'aac',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/webm': 'webm',
};

const tooLarge = () => new ApiError(413, 'FILE_TOO_LARGE', '檔案過大');
const unsupported = () => new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', '檔案格式不支援');

export function mediaRoutes({ db, config, serializers }) {
  const router = Router();
  const mediaDir = path.join(config.dataDir, 'media');
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.media.audioMaxBytes, files: 1 } }).single('file');
  const insert = db.prepare(`
    INSERT INTO media (id, owner_id, kind, filename, mime, width, height, duration_seconds, created_at)
    VALUES (@id, @owner_id, @kind, @filename, @mime, @width, @height, @duration_seconds, @created_at)
  `);
  const select = db.prepare('SELECT * FROM media WHERE id = ?');

  const parseUpload = (req, res) => new Promise((resolve, reject) => {
    upload(req, res, (err) => {
      if (err?.code === 'LIMIT_FILE_SIZE') return reject(tooLarge());
      if (err instanceof multer.MulterError) return reject(validationError('上傳內容不正確'));
      if (err) return reject(err);
      resolve();
    });
  });

  // 重新編碼會移除 EXIF（含 GPS）；無法解碼的檔案一律視為格式不支援。
  const processImage = async (file) => {
    if (file.size > config.media.imageMaxBytes) throw tooLarge();
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) throw unsupported();
    try {
      const { data, info } = await sharp(file.buffer)
        .rotate()
        .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 85 })
        .toBuffer({ resolveWithObject: true });
      return { data, ext: 'jpg', mime: 'image/jpeg', width: info.width, height: info.height, duration: null };
    } catch {
      throw unsupported();
    }
  };

  const processAudio = (file, duration) => {
    const ext = AUDIO_TYPES[file.mimetype.split(';')[0].trim()];
    if (!ext) throw unsupported();
    if (!Number.isFinite(duration) || duration <= 0 || duration > config.media.audioMaxSeconds) {
      throw validationError(`duration_seconds 必須介於 0 到 ${config.media.audioMaxSeconds}`, { field: 'duration_seconds' });
    }
    return { data: file.buffer, ext, mime: file.mimetype.split(';')[0].trim(), width: null, height: null, duration };
  };

  router.post('/media', async (req, res) => {
    await parseUpload(req, res);
    const kind = requireEnum(req.body?.kind, ['image', 'audio'], 'kind');
    if (!req.file) throw validationError('缺少 file', { field: 'file' });

    const processed = kind === 'image'
      ? await processImage(req.file)
      : processAudio(req.file, Number(req.body.duration_seconds));

    const id = newId('m');
    const filename = `${id}.${processed.ext}`;
    await fs.writeFile(path.join(mediaDir, filename), processed.data);
    insert.run({
      id, owner_id: req.user.id, kind, filename, mime: processed.mime,
      width: processed.width, height: processed.height, duration_seconds: processed.duration, created_at: nowIso(),
    });
    res.status(201).json({ data: serializers.media(req, select.get(id)) });
  });

  return router;
}

export function publicMediaRoutes({ db, config, signatures }) {
  const router = Router();
  const select = db.prepare('SELECT * FROM media WHERE id = ?');
  const pendingReport = db.prepare("SELECT 1 FROM pii_reports WHERE media_id = ? AND status = 'pending' LIMIT 1");
  router.get('/media/:id', (req, res) => {
    const row = select.get(req.params.id);
    if (!row) throw notFound();
    // 個資待確認期間，只有帶有效簽章的連結可以取得內容。
    if (pendingReport.get(row.id) && !signatures.verify(row.id, req.query.exp, req.query.sig)) throw notFound();
    res.sendFile(row.filename, {
      root: path.resolve(config.dataDir, 'media'),
      headers: { 'Content-Type': row.mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' },
    });
  });
  return router;
}

export function startMediaCleanup({ db, config }) {
  const expired = db.prepare('SELECT * FROM media WHERE question_id IS NULL AND answer_id IS NULL AND created_at < ?');
  const remove = db.prepare('DELETE FROM media WHERE id = ?');
  const timer = setInterval(async () => {
    const cutoff = new Date(Date.now() - config.media.unattachedTtlMs).toISOString();
    for (const row of expired.all(cutoff)) {
      await fs.rm(path.join(config.dataDir, 'media', row.filename), { force: true }).catch(console.error);
      remove.run(row.id);
    }
  }, 60 * 60_000);
  timer.unref();
  return timer;
}
