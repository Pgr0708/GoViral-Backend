/**
 * upload.ts — Video file upload endpoint
 *
 * POST /api/social/upload
 * Accepts a multipart/form-data request with a "video" field.
 * Saves the MP4 to the server's /uploads/ directory.
 * Returns a public HTTPS URL that TikTok / Instagram servers can access.
 */

import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { requireAuth } from '../middleware/auth';
import { logger } from '../services/logger';

const router = Router();

// ─── Ensure uploads directory exists ──────────────────────────
const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ─── Multer Storage Config ─────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (_req, file, cb) => {
    const uniqueName = `goviral_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 500 * 1024 * 1024, // 500 MB max per upload
  },
  fileFilter: (_req, file, cb) => {
    const allowedMimes = ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm'];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported video format: ${file.mimetype}`));
    }
  },
});

// ─────────────────────────────────────────────────────────────────
// POST /api/social/upload
// ─────────────────────────────────────────────────────────────────
router.post('/', requireAuth, upload.single('video'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, code: 'NO_FILE', message: 'No video file provided in "video" field' });
      return;
    }

    const baseUrl = process.env.BASE_URL ?? 'https://goviral.dakshyaminfotech.store';
    const videoUrl = `${baseUrl}/uploads/${req.file.filename}`;

    logger.info('Video uploaded', {
      userId:   req.userId,
      filename: req.file.filename,
      size:     req.file.size,
      url:      videoUrl,
    });

    res.json({ success: true, videoUrl, filename: req.file.filename });
  } catch (err) {
    logger.error('Upload error', { error: String(err) });
    res.status(500).json({ success: false, code: 'UPLOAD_FAILED', message: String(err) });
  }
});

export default router;
