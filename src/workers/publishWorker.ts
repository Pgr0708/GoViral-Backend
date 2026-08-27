/**
 * publishWorker.ts
 * Bull worker that processes social publish jobs.
 * Handles token refresh, platform upload, retry with exponential backoff.
 */

import { PrismaClient } from '@prisma/client';
import { publishQueue } from '../services/publishingService';
import { ensureFreshToken } from '../services/socialAccountService';
import { getAdapter } from '../adapters';
import { socialLog, logger } from '../services/logger';

const prisma = new PrismaClient();

publishQueue.process(async (job) => {
  const { jobId, userId, socialAccountId, platform, videoPath, metadata } = job.data;

  logger.info('Worker processing job', { jobId, platform, videoPath });

  // Mark as processing
  await prisma.socialPublishJob.update({
    where: { id: jobId },
    data:  { status: 'processing', startedAt: new Date() },
  });

  socialLog.publishStarted(jobId, platform);

  // Get fresh token (auto-refreshes if near expiry)
  const accessToken = await ensureFreshToken(userId, socialAccountId);
  const adapter     = getAdapter(platform);

  // Decide whether videoPath is a remote URL or a local file
  const isRemoteUrl = typeof videoPath === 'string' && (videoPath.startsWith('http://') || videoPath.startsWith('https://'));

  // Call platform adapter
  const result = await adapter.uploadVideo(accessToken, {
    videoPath: isRemoteUrl ? '' : videoPath,  // local path or empty
    videoUrl:  isRemoteUrl ? videoPath : undefined, // HTTPS CDN URL if remote
    title:       metadata.title,
    caption:     metadata.caption,
    description: metadata.description,
    hashtags:    metadata.hashtags,
    tags:        metadata.tags,
    commentary:  metadata.commentary,
    privacyStatus: metadata.privacyStatus,
  });

  // Mark as published
  await prisma.socialPublishJob.update({
    where: { id: jobId },
    data: {
      status:         'published',
      publishedAt:    new Date(),
      platformPostId: result.platformPostId,
      platformUrl:    result.platformUrl,
      errorMessage:   null,
      errorCode:      null,
    },
  });

  socialLog.publishSuccess(jobId, platform, result.platformUrl);
});

// Handle failed jobs
publishQueue.on('failed', async (job, err) => {
  const { jobId, platform } = job.data;
  const errorMessage = err.message ?? String(err);

  logger.error('Job failed', { jobId, platform, error: errorMessage, attempt: job.attemptsMade });

  const isLastAttempt = job.attemptsMade >= (job.opts.attempts ?? 5);
  const status = isLastAttempt ? 'failed' : 'retrying';

  await prisma.socialPublishJob.update({
    where: { id: jobId },
    data: {
      status,
      retryCount:   job.attemptsMade,
      errorMessage: errorMessage.substring(0, 500),
      errorCode:    classifyError(errorMessage),
    },
  });

  if (isLastAttempt) {
    socialLog.publishFailed(jobId, platform, errorMessage);
  }
});

function classifyError(message: string): string {
  if (message.includes('token')) return 'SOCIAL_REAUTH_REQUIRED';
  if (message.includes('rate limit') || message.includes('429')) return 'SOCIAL_RATE_LIMITED';
  if (message.includes('permission') || message.includes('403')) return 'SOCIAL_PERMISSION_DENIED';
  if (message.includes('video') || message.includes('media')) return 'SOCIAL_INVALID_VIDEO';
  return 'SOCIAL_PLATFORM_ERROR';
}

logger.info('Social publish worker started');
