/**
 * server.ts — GoViral Backend Express server
 */

import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import socialRouter from './routes/social';
import uploadRouter from './routes/upload';
import { logger } from './services/logger';

// Boot the publish worker
import './workers/publishWorker';

const app  = express();
const PORT = process.env.PORT ?? 3000;

// Ensure uploads directory exists
const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ─── Security Middleware ─────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // Allow platforms to fetch /uploads/ videos
}));
app.use(cors({
  origin: [
    'https://api.goviral.app',
    'http://localhost:3000',
    ...(process.env.ALLOWED_ORIGINS?.split(',') ?? []),
  ],
  credentials: true,
}));

// ─── Request Parsing ─────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Logging ─────────────────────────────────────────────────
app.use(morgan('combined'));

// ─── Global Rate Limit ───────────────────────────────────────
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 300 }));

// ─── Health Check ────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'goviral-backend', timestamp: new Date().toISOString() });
});

// ─── Serve Uploaded Videos as Public Static Files ────────────
// TikTok / Instagram / YouTube servers download videos from this URL
app.use('/uploads', express.static(UPLOADS_DIR, {
  maxAge: '1d',
  setHeaders: (res) => {
    res.set('Access-Control-Allow-Origin', '*');
  },
}));

// ─── Social Routes ───────────────────────────────────────────
app.use('/api/social', socialRouter);

// ─── Upload Route ────────────────────────────────────────────
app.use('/api/social/upload', uploadRouter);

// ─── 404 ─────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Route not found' });
});

// ─── Error Handler ───────────────────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
});

app.listen(PORT, () => {
  logger.info(`GoViral backend running on port ${PORT}`);
});

export default app;
