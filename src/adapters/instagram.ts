/**
 * InstagramAdapter — Meta/Instagram Graph API + oEmbed
 *
 * OAuth: Meta OAuth 2.0
 * Publishing: Instagram Graph API (Content Publishing)
 *
 * IMPORTANT: Instagram video publishing requires:
 *   - Professional/Creator/Business account
 *   - App Review approval for publish_video permission
 *   - Pages Show List + Instagram Basic Display permissions
 *
 * Scopes: instagram_basic, instagram_content_publish, pages_show_list,
 *         pages_read_engagement, business_management
 */

import axios from 'axios';
import {
  SocialPlatformAdapter, OAuthTokens, PlatformAccountInfo,
  VideoPublishOptions, PublishResult, VideoValidation
} from './base';
import { logger } from '../services/logger';

const GRAPH_BASE = 'https://graph.facebook.com/v20.0';
const AUTH_BASE  = 'https://www.facebook.com/v20.0/dialog/oauth';
const TOKEN_URL  = `${GRAPH_BASE}/oauth/access_token`;

// Instagram video limits
const MAX_VIDEO_SIZE_BYTES = 4_000_000_000;       // 4 GB
const MAX_DURATION_SECONDS = 3600;                 // 60 min

const SCOPES = [
  'instagram_basic',
  'instagram_content_publish',
  'pages_show_list',
  'pages_read_engagement',
].join(',');

export class InstagramAdapter extends SocialPlatformAdapter {
  platform = 'instagram';

  private get clientId()     { return process.env.INSTAGRAM_CLIENT_ID!; }
  private get clientSecret() { return process.env.INSTAGRAM_CLIENT_SECRET!; }
  private get redirectUri()  { return process.env.INSTAGRAM_REDIRECT_URI!; }

  getAuthorizationUrl(state: string): string {
    const params = new URLSearchParams({
      client_id:     this.clientId,
      redirect_uri:  this.redirectUri,
      scope:         SCOPES,
      response_type: 'code',
      state,
    });
    return `${AUTH_BASE}?${params}`;
  }

  async handleOAuthCallback(code: string): Promise<OAuthTokens> {
    const res = await axios.get<{ access_token: string; expires_in?: number }>(TOKEN_URL, {
      params: {
        client_id:     this.clientId,
        client_secret: this.clientSecret,
        redirect_uri:  this.redirectUri,
        code,
      },
    });

    const expiresAt = res.data.expires_in
      ? new Date(Date.now() + res.data.expires_in * 1000)
      : undefined;

    return {
      accessToken: res.data.access_token,
      expiresAt,
      scopes: SCOPES.split(','),
    };
  }

  async refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
    // Meta long-lived tokens can be refreshed
    const res = await axios.get<{ access_token: string; expires_in: number }>(
      `${GRAPH_BASE}/oauth/access_token`,
      {
        params: {
          grant_type:        'fb_exchange_token',
          client_id:         this.clientId,
          client_secret:     this.clientSecret,
          fb_exchange_token: refreshToken,
        },
      }
    );

    return {
      accessToken: res.data.access_token,
      expiresAt: new Date(Date.now() + res.data.expires_in * 1000),
    };
  }

  async getAccountInfo(accessToken: string): Promise<PlatformAccountInfo> {
    // Step 1: Get Facebook user ID
    const meRes = await axios.get<{ id: string }>(`${GRAPH_BASE}/me`, {
      params: { access_token: accessToken, fields: 'id,name' },
    });

    // Step 2: Get linked Instagram business accounts
    const pagesRes = await axios.get<{
      data: Array<{ id: string; instagram_business_account?: { id: string } }>
    }>(`${GRAPH_BASE}/${meRes.data.id}/accounts`, {
      params: { access_token: accessToken, fields: 'instagram_business_account' },
    });

    const igAccountId = pagesRes.data.data?.[0]?.instagram_business_account?.id;
    if (!igAccountId) {
      throw new Error('No Instagram Business/Creator account linked to this Facebook page');
    }

    const igRes = await axios.get<{
      id: string; username: string; name: string; profile_picture_url?: string
    }>(`${GRAPH_BASE}/${igAccountId}`, {
      params: {
        access_token: accessToken,
        fields: 'id,username,name,profile_picture_url',
      },
    });

    return {
      platformUserId:  igRes.data.id,
      platformUsername: `@${igRes.data.username}`,
      displayName:     igRes.data.name,
      profileImageUrl: igRes.data.profile_picture_url,
    };
  }

  async validateConnection(accessToken: string): Promise<boolean> {
    try {
      await axios.get(`${GRAPH_BASE}/me`, { params: { access_token: accessToken } });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Instagram Reels publish flow (Content Publishing API):
   * 1. Create a media container (VIDEO type)
   * 2. Poll until the container status is FINISHED
   * 3. Publish the container
   */
  async uploadVideo(accessToken: string, options: VideoPublishOptions): Promise<PublishResult> {
    const { caption = '', hashtags = [], videoPath } = options;
    const captionText = [caption, ...hashtags.map(h => h.startsWith('#') ? h : `#${h}`)].join(' ');

    // Step 1: Get IG account ID
    const accountInfo = await this.getAccountInfo(accessToken);
    const igUserId = accountInfo.platformUserId;

    // Step 2: Create Reels container (video must be publicly accessible URL)
    // In production, upload video to your CDN/S3 first and pass the URL
    const videoUrl = videoPath; // Should be a public URL after backend uploads to storage

    const containerRes = await axios.post<{ id: string }>(
      `${GRAPH_BASE}/${igUserId}/media`,
      {
        media_type:  'REELS',
        video_url:   videoUrl,
        caption:     captionText,
        share_to_feed: true,
      },
      { params: { access_token: accessToken } }
    );

    const containerId = containerRes.data.id;
    logger.info('Instagram container created', { containerId });

    // Step 3: Poll container status until FINISHED
    const status = await this.pollContainerStatus(accessToken, containerId);
    if (status !== 'FINISHED') {
      throw new Error(`Instagram container failed with status: ${status}`);
    }

    // Step 4: Publish the container
    const publishRes = await axios.post<{ id: string }>(
      `${GRAPH_BASE}/${igUserId}/media_publish`,
      { creation_id: containerId },
      { params: { access_token: accessToken } }
    );

    return {
      platformPostId: publishRes.data.id,
      platformUrl: `https://www.instagram.com/p/${publishRes.data.id}/`,
    };
  }

  async getPublishStatus(accessToken: string, platformPostId: string): Promise<string> {
    try {
      const res = await axios.get<{ id: string; status_code: string }>(
        `${GRAPH_BASE}/${platformPostId}`,
        { params: { access_token: accessToken, fields: 'id,status_code' } }
      );
      return res.data.status_code ?? 'UNKNOWN';
    } catch {
      return 'ERROR';
    }
  }

  async revokeConnection(_accessToken: string): Promise<void> {
    // Meta tokens can be revoked via Graph API DELETE /{user-id}/permissions
    // Implemented as no-op here; handled by the user in Facebook Settings
  }

  validateVideo(_videoPath: string, durationSeconds: number, fileSizeBytes: number): VideoValidation {
    if (fileSizeBytes > MAX_VIDEO_SIZE_BYTES) {
      return { supported: false, reason: 'Video exceeds Instagram 4 GB limit' };
    }
    if (durationSeconds > MAX_DURATION_SECONDS) {
      return { supported: false, reason: 'Video exceeds Instagram 60-minute limit' };
    }
    return { supported: true };
  }

  private async pollContainerStatus(accessToken: string, containerId: string): Promise<string> {
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise(r => setTimeout(r, 5000)); // 5s polling

      const res = await axios.get<{ status_code: string }>(
        `${GRAPH_BASE}/${containerId}`,
        { params: { access_token: accessToken, fields: 'status_code' } }
      );

      const code = res.data.status_code;
      if (code === 'FINISHED' || code === 'ERROR' || code === 'EXPIRED') {
        return code;
      }
    }
    return 'TIMEOUT';
  }
}
