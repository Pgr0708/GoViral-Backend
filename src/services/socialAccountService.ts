/**
 * socialAccountService.ts
 * Core service for managing social account CRUD, OAuth state, and token refresh.
 * NEVER expose raw tokens — always encrypt at rest, never return to frontend.
 */

import { PrismaClient } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { encryptToken, decryptToken } from './tokenEncryption';
import { getAdapter } from '../adapters';
import { socialLog, logger } from './logger';

const prisma = new PrismaClient();

const OAUTH_STATE_TTL_MINUTES = 15;

// ─────────────────────────────────────────────────────────────
// OAuth State Management (CSRF protection)
// ─────────────────────────────────────────────────────────────

export async function createOAuthState(userId: string, platform: string): Promise<string> {
  const state = uuidv4();
  const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MINUTES * 60 * 1000);

  await prisma.oAuthState.create({
    data: { state, userId, platform, expiresAt },
  });

  return state;
}

export async function validateAndConsumeOAuthState(
  state: string, platform: string
): Promise<{ userId: string }> {
  const record = await prisma.oAuthState.findUnique({ where: { state } });

  if (!record)              throw new Error('Invalid OAuth state');
  if (record.consumed)      throw new Error('OAuth state already consumed');
  if (record.platform !== platform) throw new Error('OAuth state platform mismatch');
  if (record.expiresAt < new Date()) throw new Error('OAuth state expired');

  await prisma.oAuthState.update({ where: { state }, data: { consumed: true } });

  return { userId: record.userId };
}

// ─────────────────────────────────────────────────────────────
// Account Management
// ─────────────────────────────────────────────────────────────

export async function connectAccount(
  userId: string,
  platform: string,
  code: string
): Promise<string> {
  const adapter = getAdapter(platform);

  // Exchange code for tokens
  const tokens = await adapter.handleOAuthCallback(code);

  // Fetch account info using the new access token
  const accountInfo = await adapter.getAccountInfo(tokens.accessToken);

  // Encrypt tokens before storage
  const accessTokenEnc  = encryptToken(tokens.accessToken);
  const refreshTokenEnc = tokens.refreshToken ? encryptToken(tokens.refreshToken) : null;

  // Find existing account for this user + platform
  const existing = await prisma.socialAccount.findFirst({
    where: {
      userId,
      platform,
      platformUserId: accountInfo.platformUserId,
    },
  });

  let accountId: string;

  if (existing) {
    const updated = await prisma.socialAccount.update({
      where: { id: existing.id },
      data: {
        accessTokenEnc,
        refreshTokenEnc:   refreshTokenEnc ?? undefined,
        tokenExpiresAt:    tokens.expiresAt,
        scopes:            tokens.scopes ?? [],
        status:            'connected',
        lastError:         null,
        platformUsername:  accountInfo.platformUsername,
        displayName:       accountInfo.displayName,
        profileImageUrl:   accountInfo.profileImageUrl,
      },
    });
    accountId = updated.id;
  } else {
    const created = await prisma.socialAccount.create({
      data: {
        userId,
        platform,
        platformUserId:   accountInfo.platformUserId,
        platformUsername: accountInfo.platformUsername,
        displayName:      accountInfo.displayName,
        profileImageUrl:  accountInfo.profileImageUrl,
        accessTokenEnc,
        refreshTokenEnc:  refreshTokenEnc ?? undefined,
        tokenExpiresAt:   tokens.expiresAt,
        scopes:           tokens.scopes ?? [],
        status:           'connected',
      },
    });
    accountId = created.id;
  }

  socialLog.connected(userId, platform, accountId);
  return accountId;
}

export async function disconnectAccount(userId: string, accountId: string): Promise<void> {
  const account = await prisma.socialAccount.findFirst({
    where: { id: accountId, userId },
  });

  if (!account) throw new Error('Account not found or does not belong to user');

  // Best-effort token revocation
  try {
    const adapter = getAdapter(account.platform);
    const accessToken = decryptToken(account.accessTokenEnc);
    await adapter.revokeConnection(accessToken);
  } catch (e) {
    logger.warn('Token revocation failed (best-effort)', { accountId, error: String(e) });
  }

  await prisma.socialAccount.delete({ where: { id: accountId } });
  socialLog.disconnected(userId, account.platform, accountId);
}

export async function getAccountsSafe(userId: string) {
  const accounts = await prisma.socialAccount.findMany({ where: { userId } });

  return accounts.map(a => ({
    id:              a.id,
    platform:        a.platform,
    connected:       a.status === 'connected',
    displayName:     a.displayName,
    username:        a.platformUsername,
    profileImageUrl: a.profileImageUrl,
    status:          a.status,
    connectedAt:     a.connectedAt,
    // NEVER include accessTokenEnc, refreshTokenEnc
  }));
}

export async function getAccountWithTokens(userId: string, accountId: string) {
  const account = await prisma.socialAccount.findFirst({
    where: { id: accountId, userId },
  });
  if (!account) throw new Error('Account not found');
  return account;
}

// ─────────────────────────────────────────────────────────────
// Token Refresh
// ─────────────────────────────────────────────────────────────

export async function ensureFreshToken(userId: string, accountId: string): Promise<string> {
  const account = await prisma.socialAccount.findFirst({ where: { id: accountId, userId } });
  if (!account) throw new Error('Account not found');

  const now = new Date();
  const expiresAt = account.tokenExpiresAt;
  const shouldRefresh = expiresAt && expiresAt < new Date(now.getTime() + 5 * 60 * 1000); // 5 min buffer

  if (shouldRefresh && account.refreshTokenEnc) {
    try {
      const adapter      = getAdapter(account.platform);
      const refreshToken = decryptToken(account.refreshTokenEnc);
      const newTokens    = await adapter.refreshAccessToken(refreshToken);

      const newAccessEnc   = encryptToken(newTokens.accessToken);
      const newRefreshEnc  = newTokens.refreshToken ? encryptToken(newTokens.refreshToken) : account.refreshTokenEnc;

      await prisma.socialAccount.update({
        where: { id: accountId },
        data: {
          accessTokenEnc:  newAccessEnc,
          refreshTokenEnc: newRefreshEnc,
          tokenExpiresAt:  newTokens.expiresAt,
        },
      });

      socialLog.tokenRefreshed(userId, account.platform, accountId);
      return newTokens.accessToken;
    } catch (e) {
      await prisma.socialAccount.update({
        where: { id: accountId },
        data: { status: 'reauthorization_required', lastError: String(e) },
      });
      throw new Error('Token refresh failed — user must reconnect');
    }
  }

  return decryptToken(account.accessTokenEnc);
}
