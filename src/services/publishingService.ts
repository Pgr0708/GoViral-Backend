/**
 * publishingService.ts
 * Creates and manages async social publish jobs.
 * Uses Bull queue for reliable background processing.
 */

import { PrismaClient } from '@prisma/client';
import Bull from 'bull';
import { socialLog } from './logger';

const prisma = new PrismaClient();

export const publishQueue = new Bull('social-publish', {
  redis: process.env.REDIS_URL ?? 'redis://localhost:6379',
  defaultJobOptions: {
    attempts:  5,
    backoff:   { type: 'exponential', delay: 30_000 }, // 30s → 1m → 2m → 4m → 8m
    removeOnComplete: false,
    removeOnFail:     false,
  },
});

export interface PublishJobPayload {
  userId:          string;
  videoId:         string;
  socialAccountId: string;
  platform:        string;
  metadata:        Record<string, unknown>;
  videoPath:       string; // path on backend storage or CDN URL
}

export async function createPublishJobs(
  userId: string,
  videoId: string,
  socialAccountIds: string[],
  metadata: Record<string, Record<string, unknown>>,
  videoPath: string
) {
  const { PrismaClient: _P, ...rest } = { PrismaClient: undefined };
  const accounts = await prisma.socialAccount.findMany({
    where: { id: { in: socialAccountIds }, userId, status: 'connected' },
  });

  const jobs = [];

  for (const account of accounts) {
    const platformMeta = metadata[account.platform] ?? {};

    const job = await prisma.socialPublishJob.create({
      data: {
        userId,
        videoId,
        socialAccountId: account.id,
        platform:        account.platform,
        title:           (platformMeta.title as string) ?? null,
        caption:         (platformMeta.caption as string) ?? null,
        description:     (platformMeta.description as string) ?? null,
        hashtags:        (platformMeta.hashtags as string[]) ?? [],
        tags:            (platformMeta.tags as string[]) ?? [],
        metadata:        platformMeta as import(".prisma/client").Prisma.InputJsonValue,
        status:          'queued',
      },
    });

    // Enqueue Bull job
    await publishQueue.add(
      { jobId: job.id, userId, videoId, socialAccountId: account.id, platform: account.platform, videoPath, metadata: platformMeta },
      { jobId: job.id }
    );

    socialLog.publishJobCreated(userId, job.id, account.platform);
    jobs.push({
      id:       job.id,
      platform: account.platform,
      status:   'queued',
    });
  }

  return jobs;
}

export async function getJobStatus(userId: string, jobId: string) {
  const job = await prisma.socialPublishJob.findFirst({ where: { id: jobId, userId } });
  if (!job) throw new Error('Job not found');

  return {
    id:              job.id,
    platform:        job.platform,
    status:          job.status,
    title:           job.title,
    errorMessage:    job.errorMessage,
    platformPostId:  job.platformPostId,
    platformUrl:     job.platformUrl,
    createdAt:       job.createdAt,
    publishedAt:     job.publishedAt,
  };
}

export async function getUserJobs(userId: string) {
  const jobs = await prisma.socialPublishJob.findMany({
    where:   { userId },
    orderBy: { createdAt: 'desc' },
    take:    50,
  });

  return jobs.map(job => ({
    id:              job.id,
    platform:        job.platform,
    status:          job.status,
    title:           job.title,
    errorMessage:    job.errorMessage,
    platformPostId:  job.platformPostId,
    platformUrl:     job.platformUrl,
    createdAt:       job.createdAt,
    publishedAt:     job.publishedAt,
  }));
}
