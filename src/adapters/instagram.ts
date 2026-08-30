/**
 * InstagramAdapter — Meta Instagram Graph API / Direct Instagram Login
 */

import axios from 'axios';
import {
  SocialPlatformAdapter, OAuthTokens, PlatformAccountInfo,
  VideoPublishOptions, PublishResult, VideoValidation
} from './base';
import { logger } from '../services/logger';

const GRAPH_BASE   = 'https://graph.facebook.com/v20.0';
const IG_AUTH_BASE = 'https://www.instagram.com/oauth/authorize';
const IG_TOKEN_URL = 'https://api.instagram.com/oauth/access_token';

// Instagram video limits
const MAX_VIDEO_SIZE_BYTES = 4_000_000_000;       // 4 GB
const MAX_DURATION_SECONDS = 3600;                 // 60 min

export class InstagramAdapter extends SocialPlatformAdapter {
  platform = 'instagram';

  private get clientId()     { return process.env.INSTAGRAM_CLIENT_ID!; }
  private get clientSecret() { return process.env.INSTAGRAM_CLIENT_SECRET!; }
  private get redirectUri()  { return process.env.INSTAGRAM_REDIRECT_URI!; }

  // Use Instagram Business scopes
  private get scopes() {
    return [
      'instagram_business_basic',
      'instagram_business_content_publish',
      'instagram_business_manage_messages',
      'instagram_business_manage_comments',
    ].join(',');
  }

  getAuthorizationUrl(state: string): string {
    const params = new URLSearchParams({
      client_id:     this.clientId,
      redirect_uri:  this.redirectUri,
      scope:         this.scopes,
      response_type: 'code',
      state,
    });
    return `${IG_AUTH_BASE}?${params}`;
  }

  async handleOAuthCallback(code: string): Promise<OAuthTokens> {
    const cleanCode = code.replace(/#_.*$/, '');

    // Step 1: Exchange short-lived token
    let accessToken: string;
    let expiresIn: number | undefined;

    const params = new URLSearchParams({
      client_id:     this.clientId,
      client_secret: this.clientSecret,
      grant_type:    'authorization_code',
      redirect_uri:  this.redirectUri,
      code:          cleanCode,
    });

    try {
      const res = await axios.post<{ access_token: string; user_id?: string }>(
        IG_TOKEN_URL,
        params.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      accessToken = res.data.access_token;
    } catch (igErr) {
      logger.warn('Direct IG token exchange failed, trying Graph endpoint...', { error: String(igErr) });
      const res = await axios.get<{ access_token: string; expires_in?: number }>(
        `${GRAPH_BASE}/oauth/access_token`,
        {
          params: {
            client_id:     this.clientId,
            client_secret: this.clientSecret,
            redirect_uri:  this.redirectUri,
            code:          cleanCode,
          },
        }
      );
      accessToken = res.data.access_token;
      expiresIn   = res.data.expires_in;
    }

    // Step 2: Exchange for long-lived 60-day token
    try {
      const longLivedRes = await axios.get<{ access_token: string; expires_in: number }>(
        'https://graph.instagram.com/access_token',
        {
          params: {
            grant_type:    'ig_exchange_token',
            client_secret: this.clientSecret,
            access_token:  accessToken,
          },
        }
      );
      if (longLivedRes.data.access_token) {
        accessToken = longLivedRes.data.access_token;
        expiresIn   = longLivedRes.data.expires_in;
      }
    } catch {
      logger.info('Using standard access token for Instagram');
    }

    return {
      accessToken,
      expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : undefined,
      scopes:    this.scopes.split(','),
    };
  }

  async refreshAccessToken(accessToken: string): Promise<OAuthTokens> {
    const res = await axios.get<{ access_token: string; expires_in: number }>(
      'https://graph.instagram.com/refresh_access_token',
      {
        params: {
          grant_type:   'ig_refresh_token',
          access_token: accessToken,
        },
      }
    );

    return {
      accessToken: res.data.access_token,
      expiresAt:   new Date(Date.now() + res.data.expires_in * 1000),
    };
  }

  async getAccountInfo(accessToken: string): Promise<PlatformAccountInfo> {
    try {
      const res = await axios.get<{
        id: string;
        username?: string;
      }>('https://graph.instagram.com/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
        params:  { fields: 'id,username' },
      });

      return {
        platformUserId:   res.data.id,
        platformUsername: res.data.username ? `@${res.data.username}` : undefined,
        displayName:      res.data.username ? `@${res.data.username}` : 'Instagram Account',
      };
    } catch (e) {
      logger.warn('Failed to fetch Instagram /me profile, using default info', { error: String(e) });
      return {
        platformUserId:   'instagram_user',
        platformUsername: '@instagram',
        displayName:      'Instagram Account',
      };
    }
  }

  async validateConnection(accessToken: string): Promise<boolean> {
    try {
      await axios.get('https://graph.instagram.com/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
        params:  { fields: 'id' },
      });
      return true;
    } catch { return false; }
  }

  /**
   * Upload video as an Instagram Reel
   */
  async uploadVideo(accessToken: string, options: VideoPublishOptions): Promise<PublishResult> {
    const videoUrl = options.videoUrl || options.videoPath;
    const { caption = '', hashtags = [] } = options;

    if (!videoUrl) {
      throw new Error('Instagram requires a public HTTPS videoUrl for upload');
    }

    const fullCaption = [
      caption,
      hashtags.map(h => h.startsWith('#') ? h : `#${h}`).join(' ')
    ].filter(Boolean).join('\n\n');

    // Step 1: Create media container
    const containerParams: Record<string, string> = {
      media_type:   'REELS',
      video_url:    videoUrl,
      access_token: accessToken,
    };
    if (fullCaption && fullCaption.trim().length > 0) {
      containerParams.caption = fullCaption;
    }

    const containerRes = await axios.post<{ id: string }>(
      'https://graph.instagram.com/me/media',
      null,
      { params: containerParams }
    );
    const containerId = containerRes.data.id;

    // Step 2: Poll container status until FINISHED
    await this.pollContainerStatus(containerId, accessToken);

    // Step 3: Publish container
    const publishRes = await axios.post<{ id: string }>(
      'https://graph.instagram.com/me/media_publish',
      null,
      {
        params: {
          creation_id:  containerId,
          access_token: accessToken,
        },
      }
    );

    const mediaId = publishRes.data.id;
    return {
      platformPostId: mediaId,
      platformUrl:    `https://www.instagram.com/p/${mediaId}/`,
    };
  }

  private async pollContainerStatus(containerId: string, accessToken: string): Promise<void> {
    const maxAttempts = 30; // 30 * 5s = 2.5 min
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const res = await axios.get<{ status_code: string }>(
        `https://graph.instagram.com/${containerId}`,
        { params: { fields: 'status_code', access_token: accessToken } }
      );
      if (res.data.status_code === 'FINISHED') return;
      if (res.data.status_code === 'ERROR') throw new Error('Instagram media processing failed');
    }
    throw new Error('Instagram media processing timed out');
  }

  async getPublishStatus(_accessToken: string, _platformPostId: string): Promise<string> {
    return 'published';
  }

  async revokeConnection(_accessToken: string): Promise<void> {
    // Handled via user's Instagram Connected Apps
  }

  validateVideo(_path: string, durationSeconds: number, fileSizeBytes: number): VideoValidation {
    if (fileSizeBytes > MAX_VIDEO_SIZE_BYTES) return { supported: false, reason: 'Exceeds Instagram 4 GB limit' };
    if (durationSeconds > MAX_DURATION_SECONDS) return { supported: false, reason: 'Exceeds Instagram 60-minute limit' };
    return { supported: true };
  }
}
