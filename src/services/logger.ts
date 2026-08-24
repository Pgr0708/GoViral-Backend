/**
 * logger.ts — Winston structured logger.
 * NEVER log: access_token, refresh_token, client_secret, authorization_code
 */

import winston from 'winston';

const { combine, timestamp, json, colorize, simple } = winston.format;

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  format: combine(timestamp(), json()),
  transports: [
    new winston.transports.Console({
      format: process.env.NODE_ENV === 'development'
        ? combine(colorize(), simple())
        : combine(timestamp(), json()),
    }),
  ],
});

// Structured event loggers
export const socialLog = {
  connectStarted:   (userId: string, platform: string) =>
    logger.info('SOCIAL_CONNECT_STARTED', { userId, platform }),
  connected:        (userId: string, platform: string, accountId: string) =>
    logger.info('SOCIAL_CONNECTED', { userId, platform, accountId }),
  disconnected:     (userId: string, platform: string, accountId: string) =>
    logger.info('SOCIAL_DISCONNECTED', { userId, platform, accountId }),
  tokenRefreshed:   (userId: string, platform: string, accountId: string) =>
    logger.info('SOCIAL_TOKEN_REFRESHED', { userId, platform, accountId }),
  publishJobCreated: (userId: string, jobId: string, platform: string) =>
    logger.info('PUBLISH_JOB_CREATED', { userId, jobId, platform }),
  publishStarted:   (jobId: string, platform: string) =>
    logger.info('PUBLISH_STARTED', { jobId, platform }),
  publishSuccess:   (jobId: string, platform: string, platformUrl?: string) =>
    logger.info('PUBLISH_SUCCESS', { jobId, platform, platformUrl }),
  publishFailed:    (jobId: string, platform: string, error: string) =>
    logger.error('PUBLISH_FAILED', { jobId, platform, error }),
};
