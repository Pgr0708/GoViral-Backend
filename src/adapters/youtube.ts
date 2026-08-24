/**
 * YouTubeAdapter — Google OAuth 2.0 + YouTube Data API v3
 *
 * OAuth: Google OAuth 2.0
 * Publishing: YouTube Data API v3 (videos.insert)
 *
 * NO special approval needed — available to any Google Cloud project.
 *
 * Scopes: youtube.upload, youtube.force-ssl
 */

import { google, youtube_v3 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import fs from 'fs';
import {
  SocialPlatformAdapter, OAuthTokens, PlatformAccountInfo,
  VideoPublishOptions, PublishResult, VideoValidation
} from './base';

const MAX_VIDEO_SIZE_BYTES  = 137_438_953_472; // 128 GB
const MAX_DURATION_SECONDS  = 43200;            // 12 hrs

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.force-ssl',
  'https://www.googleapis.com/auth/userinfo.profile',
];

export class YouTubeAdapter extends SocialPlatformAdapter {
  platform = 'youtube';

  private get clientId()     { return process.env.YOUTUBE_CLIENT_ID!; }
  private get clientSecret() { return process.env.YOUTUBE_CLIENT_SECRET!; }
  private get redirectUri()  { return process.env.YOUTUBE_REDIRECT_URI!; }

  private createOAuth2Client(): OAuth2Client {
    return new google.auth.OAuth2(this.clientId, this.clientSecret, this.redirectUri);
  }

  getAuthorizationUrl(state: string): string {
    const oauth2 = this.createOAuth2Client();
    return oauth2.generateAuthUrl({
      access_type: 'offline',
      prompt:      'consent',
      scope:       SCOPES,
      state,
    });
  }

  async handleOAuthCallback(code: string): Promise<OAuthTokens> {
    const oauth2 = this.createOAuth2Client();
    const { tokens } = await oauth2.getToken(code);

    return {
      accessToken:  tokens.access_token!,
      refreshToken: tokens.refresh_token ?? undefined,
      expiresAt:    tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
      scopes:       SCOPES,
    };
  }

  async refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
    const oauth2 = this.createOAuth2Client();
    oauth2.setCredentials({ refresh_token: refreshToken });
    const { credentials } = await oauth2.refreshAccessToken();

    return {
      accessToken:  credentials.access_token!,
      refreshToken: credentials.refresh_token ?? refreshToken,
      expiresAt:    credentials.expiry_date ? new Date(credentials.expiry_date) : undefined,
    };
  }

  async getAccountInfo(accessToken: string): Promise<PlatformAccountInfo> {
    const oauth2 = this.createOAuth2Client();
    oauth2.setCredentials({ access_token: accessToken });

    const yt = google.youtube({ version: 'v3', auth: oauth2 });
    const res = await yt.channels.list({ part: ['snippet'], mine: true });
    const channel = res.data.items?.[0];

    if (!channel) throw new Error('No YouTube channel found');

    return {
      platformUserId:  channel.id!,
      displayName:     channel.snippet?.title ?? 'YouTube Channel',
      profileImageUrl: channel.snippet?.thumbnails?.default?.url ?? undefined,
    };
  }

  async validateConnection(accessToken: string): Promise<boolean> {
    try {
      const oauth2 = this.createOAuth2Client();
      oauth2.setCredentials({ access_token: accessToken });
      const yt = google.youtube({ version: 'v3', auth: oauth2 });
      await yt.channels.list({ part: ['id'], mine: true });
      return true;
    } catch { return false; }
  }

  async uploadVideo(accessToken: string, options: VideoPublishOptions): Promise<PublishResult> {
    const {
      title = 'GoViral Video',
      description = '',
      tags = [],
      hashtags = [],
      privacyStatus = 'private',
      scheduledAt,
      videoPath,
    } = options;

    const oauth2 = this.createOAuth2Client();
    oauth2.setCredentials({ access_token: accessToken });
    const yt = google.youtube({ version: 'v3', auth: oauth2 });

    const allTags = [...tags, ...hashtags.map(h => h.replace(/^#/, ''))];

    const resource: youtube_v3.Schema$Video = {
      snippet: {
        title: title.substring(0, 100),
        description: description.substring(0, 5000),
        tags: allTags,
        categoryId: '22', // People & Blogs
      },
      status: {
        privacyStatus,
        ...(scheduledAt && privacyStatus === 'private' ? {
          publishAt: scheduledAt.toISOString(),
        } : {}),
      },
    };

    const res = await yt.videos.insert({
      part: ['snippet', 'status'],
      requestBody: resource,
      media: {
        body: fs.createReadStream(videoPath),
        mimeType: 'video/*',
      },
    });

    const videoId = res.data.id!;
    return {
      platformPostId: videoId,
      platformUrl: `https://www.youtube.com/watch?v=${videoId}`,
    };
  }

  async getPublishStatus(accessToken: string, platformPostId: string): Promise<string> {
    try {
      const oauth2 = this.createOAuth2Client();
      oauth2.setCredentials({ access_token: accessToken });
      const yt = google.youtube({ version: 'v3', auth: oauth2 });
      const res = await yt.videos.list({ part: ['status'], id: [platformPostId] });
      return res.data.items?.[0]?.status?.uploadStatus ?? 'unknown';
    } catch { return 'failed'; }
  }

  async revokeConnection(accessToken: string): Promise<void> {
    const oauth2 = this.createOAuth2Client();
    oauth2.setCredentials({ access_token: accessToken });
    await oauth2.revokeToken(accessToken);
  }

  validateVideo(_path: string, durationSeconds: number, fileSizeBytes: number): VideoValidation {
    if (fileSizeBytes > MAX_VIDEO_SIZE_BYTES) return { supported: false, reason: 'Exceeds YouTube 128 GB limit' };
    if (durationSeconds > MAX_DURATION_SECONDS) return { supported: false, reason: 'Exceeds YouTube 12-hour limit' };
    return { supported: true };
  }
}
