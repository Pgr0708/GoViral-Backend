/**
 * auth.ts — JWT authentication middleware
 * Verifies GoViral user JWT and attaches userId to req.
 * Integrate with your existing Firebase/RevenueCat user identity.
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ success: false, code: 'UNAUTHORIZED', message: 'Authentication required' });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as { userId: string };
    req.userId = payload.userId;
    next();
  } catch {
    res.status(401).json({ success: false, code: 'UNAUTHORIZED', message: 'Invalid or expired token' });
  }
}

export function validatePlatform(req: Request, res: Response, next: NextFunction): void {
  const { platform } = req.params;
  const supported = ['instagram', 'tiktok', 'youtube', 'linkedin'];

  if (!supported.includes(platform)) {
    res.status(400).json({
      success: false,
      code: 'INVALID_PLATFORM',
      message: `Unsupported platform: ${platform}. Supported: ${supported.join(', ')}`,
    });
    return;
  }

  next();
}
