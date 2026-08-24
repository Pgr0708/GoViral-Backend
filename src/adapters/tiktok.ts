/**
 * TikTokAdapter — TikTok Login Kit + Content Posting API
 *
 * OAuth: TikTok Login Kit v2
 * Publishing: TikTok Content Posting API
 *
 * IMPORTANT: TikTok video publishing (video.publish scope) requires:
 *   - TikTok Developer App approval
 *   - Content Posting API partner access (apply at developers.tiktok.com)
 *   - Without approval: system falls back to draft mode (video.upload)
 *
 * Scopes: user.info.basic, video.publish, video.upload
 */

import axios from 'axios';
import fs from 'fs';
import {
  SocialPlatformAdapter, OAuthTokens, PlatformAccountInfo,
  VideoPublishOptions, PublishResult, VideoValidation
} from './base';

const AUTH_BASE    = 'https://www.tiktok.com/v2/auth/authorize/';
const TOKEN_URL    = 'https://open.tiktokapis.com/v2/oauth/token/';
const USER_INFO_URL = 'https://open.tiktokapis.com/v2/user/info/';

const MAX_VIDEO_SIZE_BYTES = 4_000_000_000;  // 4 GB
const MAX_DURATION_SECONDS = 600;             // 10 min

const SCOPES = ['user.info.basic', 'video.publish', 'video.upload'].join(',');

export class TikTokAdapter extends SocialPlatformAdapter {
  platform = 'tiktok';

  private get clientKey()    { return process.env.TIKTOK_CLIENT_KEY!; }
  private get clientSecret() { return process.env.TIKTOK_CLIENT_SECRET!; }
  private get redirectUri()  { return process.env.TIKTOK_REDIRECT_URI!; }

  getAuthorizationUrl(state: string): string {
    const params = new URLSearchParams({
      client_key:    this.clientKey,
      response_type: 'code',
      scope:         SCOPES,
      redirect_uri:  this.redirectUri,
      state,
    });
    return `${AUTH_BASE}?${params}`;
  }

  async handleOAuthCallback(code: string): Promise<OAuthTokens> {
    const res = await axios.post<{
      data: {
        access_token: string; refresh_token: string;
        expires_in: number; refresh_expires_in: number; scope: string;
      };
      error?: { code: string; message: string };
    }>(TOKEN_URL, new URLSearchParams({
      client_key:    this.clientKey,
      client_secret: this.clientSecret,
      code,
      grant_type:    'authorization_code',
      redirect_uri:  this.redirectUri,
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    if (res.data.error) throw new Error(res.data.error.message);
    const { access_token, refresh_token, expires_in, scope } = res.data.data;

    return {
      accessToken:  access_token,
      refreshToken: refresh_token,
      expiresAt:    new Date(Date.now() + expires_in * 1000),
      scopes:       scope.split(','),
    };
  }

  async refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
    const res = await axios.post<{
      data: { access_token: string; refresh_token: string; expires_in: number };
    }>(TOKEN_URL, new URLSearchParams({
      client_key:    this.clientKey,
      client_secret: this.clientSecret,
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    const { access_token, refresh_token: newRefresh, expires_in } = res.data.data;
    return {
      accessToken:  access_token,
      refreshToken: newRefresh,
      expiresAt:    new Date(Date.now() + expires_in * 1000),
    };
  }

  async getAccountInfo(accessToken: string): Promise<PlatformAccountInfo> {
    const res = await axios.get<{
      data: { user: { open_id: string; display_name: string; avatar_url: string; username?: string } }
    }>(USER_INFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params:  { fields: 'open_id,display_name,avatar_url,username' },
    });

    const user = res.data.data.user;
    return {
      platformUserId:  user.open_id,
      platformUsername: user.username ? `@${user.username}` : undefined,
      displayName:     user.display_name,
      profileImageUrl: user.avatar_url,
    };
  }

  async validateConnection(accessToken: string): Promise<boolean> {
    try {
      await axios.get(USER_INFO_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { fields: 'open_id' },
      });
      return true;
    } catch { return false; }
  }

  /**
   * TikTok Content Posting API flow:
   * 1. Initialize upload
   * 2. Upload video chunks
   * 3. Complete upload → publish
   */
  async uploadVideo(accessToken: string, options: VideoPublishOptions): Promise<PublishResult> {
    const { caption = '', hashtags = [], videoPath } = options;
    const captionText = [caption, ...hashtags.map(h => h.startsWith('#') ? h : `#${h}`)].join(' ');
    const fileSize = fs.statSync(videoPath).size;

    // Step 1: Initialize post
    const initRes = await axios.post<{
      data: { publish_id: string; upload_url?: string }
    }>('https://open.tiktokapis.com/v2/post/publish/inbox/video/init/', {
      post_info: { title: captionText, privacy_level: 'SELF_ONLY' },
      source_info: {
        source:     'FILE_UPLOAD',
        video_size: fileSize,
        chunk_size: fileSize,
        total_chunk_count: 1,
      },
    }, { headers: { Authorization: `Bearer ${accessToken}` } });

    const { publish_id, upload_url } = initRes.data.data;

    // Step 2: Upload video binary
    const videoBuffer = fs.readFileSync(videoPath);
    await axios.put(upload_url!, videoBuffer, {
      headers: {
        'Content-Type':  'video/mp4',
        'Content-Range': `bytes 0-${fileSize - 1}/${fileSize}`,
        'Content-Length': fileSize,
      },
    });

    return { platformPostId: publish_id };
  }

  async getPublishStatus(accessToken: string, platformPostId: string): Promise<string> {
    try {
      const res = await axios.post<{
        data: { status: string; publicaly_available_post_id?: string[] }
      }>('https://open.tiktokapis.com/v2/post/publish/status/fetch/', {
        publish_id: platformPostId,
      }, { headers: { Authorization: `Bearer ${accessToken}` } });

      const { status, publicaly_available_post_id } = res.data.data;
      // If published, return the public post ID as URL
      return status;
    } catch { return 'FAILED'; }
  }

  async revokeConnection(accessToken: string): Promise<void> {
    try {
      await axios.post('https://open.tiktokapis.com/v2/oauth/revoke/', {
        client_key: this.clientKey, token: accessToken,
      });
    } catch { /* best-effort */ }
  }

  validateVideo(_path: string, durationSeconds: number, fileSizeBytes: number): VideoValidation {
    if (fileSizeBytes > MAX_VIDEO_SIZE_BYTES) return { supported: false, reason: 'Exceeds TikTok 4 GB limit' };
    if (durationSeconds > MAX_DURATION_SECONDS) return { supported: false, reason: 'Exceeds TikTok 10-minute limit' };
    return { supported: true };
  }
}
