/**
 * social.ts — All social account + publishing + upload routes
 */

import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { requireAuth, validatePlatform } from '../middleware/auth';
import {
  createOAuthState,
  validateAndConsumeOAuthState,
  connectAccount,
  disconnectAccount,
  getAccountsSafe,
} from '../services/socialAccountService';
import {
  createPublishJobs,
  getJobStatus,
  getUserJobs,
} from '../services/publishingService';
import { socialLog, logger } from '../services/logger';

const router = Router();

// ─── Rate limiting ──────────────────────────────────────────
const oauthLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });
const publishLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });

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

// ─────────────────────────────────────────────────────────────
// Video Upload
// POST /api/social/upload
// ─────────────────────────────────────────────────────────────
router.post('/upload', requireAuth, upload.single('video'), async (req: Request, res: Response) => {
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

// ─────────────────────────────────────────────────────────────
// OAuth — Connect
// GET /api/social/:platform/connect
// ─────────────────────────────────────────────────────────────
router.get('/:platform/connect', requireAuth, validatePlatform, oauthLimiter, async (req: Request, res: Response) => {
  try {
    const { platform } = req.params;
    const userId = req.userId!;

    const state = await createOAuthState(userId, platform);
    const { getAdapter } = await import('../adapters');
    const authorizationUrl = getAdapter(platform).getAuthorizationUrl(state);

    socialLog.connectStarted(userId, platform);

    res.json({ authorizationUrl, state });
  } catch (err) {
    logger.error('OAuth connect error', { error: String(err) });
    res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Failed to generate OAuth URL' });
  }
});

// ─────────────────────────────────────────────────────────────
// OAuth — Callback
// GET /api/social/:platform/callback
// ─────────────────────────────────────────────────────────────
router.get('/:platform/callback', validatePlatform, async (req: Request, res: Response) => {
  const { platform } = req.params;
  const { code, state, error } = req.query as Record<string, string>;

  if (error) {
    logger.warn('OAuth callback error from platform', { platform, error });
    return res.redirect(`${process.env.IOS_APP_URL}?platform=${platform}&error=${encodeURIComponent(error)}`);
  }

  if (!code || !state) {
    return res.redirect(`${process.env.IOS_APP_URL}?platform=${platform}&error=missing_params`);
  }

  const cleanCode = (code || '').replace(/#_.*$/, '').trim();
  const cleanState = (state || '').replace(/#_.*$/, '').trim();

  try {
    // Validate CSRF state — do not trust userId from URL
    const { userId } = await validateAndConsumeOAuthState(cleanState, platform);
    const accountId  = await connectAccount(userId, platform, cleanCode);

    // Redirect back to iOS app via deep link
    res.redirect(`${process.env.IOS_APP_URL}?platform=${platform}&status=connected&accountId=${accountId}`);
  } catch (err: any) {
    const errorDetail = err?.message || String(err);
    logger.error('OAuth callback processing error', { platform, error: errorDetail });
    res.redirect(`${process.env.IOS_APP_URL}?platform=${platform}&error=${encodeURIComponent(errorDetail)}`);
  }
});

// ─────────────────────────────────────────────────────────────
// Accounts
// ─────────────────────────────────────────────────────────────
router.get('/accounts', requireAuth, async (req: Request, res: Response) => {
  try {
    const accounts = await getAccountsSafe(req.userId!);
    res.json({ accounts });
  } catch (err) {
    res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: String(err) });
  }
});

router.post('/accounts/:id/disconnect', requireAuth, async (req: Request, res: Response) => {
  try {
    await disconnectAccount(req.userId!, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, code: 'DISCONNECT_FAILED', message: String(err) });
  }
});

router.post('/accounts/:id/refresh', requireAuth, async (req: Request, res: Response) => {
  try {
    const { ensureFreshToken } = await import('../services/socialAccountService');
    await ensureFreshToken(req.userId!, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, code: 'REFRESH_FAILED', message: String(err) });
  }
});

// ─────────────────────────────────────────────────────────────
// Publishing
// ─────────────────────────────────────────────────────────────
const PublishSchema = z.object({
  videoId:          z.string().min(1),
  socialAccountIds: z.array(z.string()).min(1).max(4),
  metadata:         z.object({
    instagram: z.object({ caption: z.string().optional(), hashtags: z.array(z.string()).optional() }).optional(),
    tiktok:    z.object({ caption: z.string().optional(), hashtags: z.array(z.string()).optional() }).optional(),
    youtube:   z.object({ title: z.string().optional(), description: z.string().optional(), tags: z.array(z.string()).optional(), privacyStatus: z.string().optional() }).optional(),
    linkedin:  z.object({ commentary: z.string().optional(), hashtags: z.array(z.string()).optional() }).optional(),
  }).optional(),
  videoPath: z.string().min(1),
});

router.post('/publish', requireAuth, publishLimiter, async (req: Request, res: Response) => {
  const parsed = PublishSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, code: 'INVALID_REQUEST', message: parsed.error.message });
    return;
  }

  try {
    const { videoId, socialAccountIds, metadata = {}, videoPath } = parsed.data;
    const jobs = await createPublishJobs(req.userId!, videoId, socialAccountIds, metadata as Record<string, Record<string, unknown>>, videoPath);
    res.json({ jobs });
  } catch (err) {
    res.status(500).json({ success: false, code: 'PUBLISH_FAILED', message: String(err) });
  }
});

router.get('/publish/jobs', requireAuth, async (req: Request, res: Response) => {
  try {
    const jobs = await getUserJobs(req.userId!);
    res.json({ jobs });
  } catch (err) {
    res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: String(err) });
  }
});

router.get('/publish/jobs/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const job = await getJobStatus(req.userId!, req.params.id);
    res.json(job);
  } catch (err) {
    res.status(404).json({ success: false, code: 'JOB_NOT_FOUND', message: String(err) });
  }
});

export default router;
