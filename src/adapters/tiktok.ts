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
    const res = await axios.post(
      TOKEN_URL,
      new URLSearchParams({
        client_key:    this.clientKey,
        client_secret: this.clientSecret,
        code,
        grant_type:    'authorization_code',
        redirect_uri:  this.redirectUri,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const data = (res.data as any)?.data || res.data;
    if ((res.data as any)?.error || (data as any)?.error_code) {
      const errMsg = (res.data as any)?.error_description || (res.data as any)?.error?.message || (data as any)?.description || 'TikTok token exchange failed';
      throw new Error(errMsg);
    }

    const access_token = (data as any).access_token;
    const refresh_token = (data as any).refresh_token;
    const expires_in = (data as any).expires_in ?? 86400;
    const scope = (data as any).scope ?? 'user.info.basic';

    if (!access_token) {
      throw new Error(`TikTok token missing in response: ${JSON.stringify(res.data)}`);
    }

    return {
      accessToken:  access_token,
      refreshToken: refresh_token,
      expiresAt:    new Date(Date.now() + expires_in * 1000),
      scopes:       typeof scope === 'string' ? scope.split(',') : [],
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
    try {
      const res = await axios.get(USER_INFO_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
        params:  { fields: 'open_id,union_id,avatar_url,display_name' },
      });

      const user = (res.data as any)?.data?.user || (res.data as any)?.data || (res.data as any)?.user;
      return {
        platformUserId:  user?.open_id || user?.union_id || `tiktok_${Date.now()}`,
        platformUsername: user?.username ? `@${user.username}` : (user?.display_name ? `@${user.display_name.replace(/\s+/g, '').toLowerCase()}` : undefined),
        displayName:     user?.display_name || 'TikTok Creator',
        profileImageUrl: user?.avatar_url || user?.avatar_url_100,
      };
    } catch (err: any) {
      console.warn('[TIKTOK] getAccountInfo fallback:', err?.response?.data || err?.message);
      return {
        platformUserId:  `tiktok_${Date.now()}`,
        displayName:     'TikTok Account',
      };
    }
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
   *
   * If videoPath is an HTTPS URL:
   *   Use PULL_FROM_URL source_type (TikTok fetches from URL directly)
   *
   * If videoPath is a local file:
   *   Use FILE_UPLOAD source_type (upload binary chunks)
   */
  async uploadVideo(accessToken: string, options: VideoPublishOptions): Promise<PublishResult> {
    const { caption = '', hashtags = [], videoPath, videoUrl } = options;
    const captionText = [caption, ...hashtags.map(h => h.startsWith('#') ? h : `#${h}`)].join(' ');

    // Use provided videoUrl, or check if videoPath is an HTTPS URL
    const remoteUrl = videoUrl || (videoPath?.startsWith('http') ? videoPath : undefined);

    if (remoteUrl) {
      // ── PULL_FROM_URL mode (preferred — TikTok fetches the video itself) ──
      console.log('[TIKTOK] Using PULL_FROM_URL mode:', remoteUrl);

      const initRes = await axios.post<{
        data: { publish_id: string }
      }>('https://open.tiktokapis.com/v2/post/publish/video/init/', {
        post_info: {
          title:         captionText.slice(0, 150),
          privacy_level: 'SELF_ONLY',
        },
        source_info: {
          source:    'PULL_FROM_URL',
          video_url: remoteUrl,
        },
      }, { headers: { Authorization: `Bearer ${accessToken}` } });

      const { publish_id } = initRes.data.data;
      return { platformPostId: publish_id };

    } else if (videoPath && fs.existsSync(videoPath)) {
      // ── FILE_UPLOAD mode (local file on backend server) ──
      console.log('[TIKTOK] Using FILE_UPLOAD mode:', videoPath);

      const fileSize = fs.statSync(videoPath).size;
      const initRes = await axios.post<{
        data: { publish_id: string; upload_url?: string }
      }>('https://open.tiktokapis.com/v2/post/publish/inbox/video/init/', {
        post_info: { title: captionText, privacy_level: 'SELF_ONLY' },
        source_info: {
          source:            'FILE_UPLOAD',
          video_size:        fileSize,
          chunk_size:        fileSize,
          total_chunk_count: 1,
        },
      }, { headers: { Authorization: `Bearer ${accessToken}` } });

      const { publish_id, upload_url } = initRes.data.data;

      const videoBuffer = fs.readFileSync(videoPath);
      await axios.put(upload_url!, videoBuffer, {
        headers: {
          'Content-Type':   'video/mp4',
          'Content-Range':  `bytes 0-${fileSize - 1}/${fileSize}`,
          'Content-Length': fileSize,
        },
      });

      return { platformPostId: publish_id };

    } else {
      throw new Error(`TikTok uploadVideo: no valid videoPath or videoUrl provided. Got: videoPath=${videoPath}, videoUrl=${videoUrl}`);
    }
  }

  async getPublishStatus(accessToken: string, platformPostId: string): Promise<string> {
    try {
      const res = await axios.post<{
        data: { status: string; publicaly_available_post_id?: string[] }
      }>('https://open.tiktokapis.com/v2/post/publish/status/fetch/', {
        publish_id: platformPostId,
      }, { headers: { Authorization: `Bearer ${accessToken}` } });

      const { status } = res.data.data;
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
