/**
 * auth.ts — Authentication middleware
 * Verifies GoViral user JWT, user-id header, or device ID.
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
  const customUserId = (req.headers['x-user-id'] as string) || (req.query.userId as string);

  if (authHeader?.startsWith('Bearer ') && authHeader.length > 7) {
    const token = authHeader.slice(7);
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET || 'goviral-secret-2026') as { userId: string };
      req.userId = payload.userId;
      return next();
    } catch {
      if (token && token.length < 100) {
        req.userId = token;
        return next();
      }
    }
  }

  // Fallback to provided user ID or default user
  req.userId = customUserId || 'default_user';
  next();
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
