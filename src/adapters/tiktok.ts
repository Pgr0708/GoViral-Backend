/**
 * TikTokAdapter — TikTok Login Kit + Content Posting API
 *
 * Scopes: user.info.basic, video.publish, video.upload
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
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
   * TikTok Multi-Tier Fail-Safe Publishing:
   * 1. Direct Publish via PULL_FROM_URL
   * 2. Direct Publish via Local File Binary
   * 3. Creator Inbox Draft Fallback
   */
  async uploadVideo(accessToken: string, options: VideoPublishOptions): Promise<PublishResult> {
    const { caption = '', hashtags = [], videoPath, videoUrl, privacyStatus = 'public' } = options;
    const captionText = [caption, ...hashtags.map(h => h.startsWith('#') ? h : `#${h}`)].join(' ').slice(0, 150);

    const remoteUrl = videoUrl || (videoPath?.startsWith('http') ? videoPath : undefined);

    let localFilePath: string | undefined = undefined;
    if (videoPath && fs.existsSync(videoPath)) {
      localFilePath = videoPath;
    } else if (videoPath) {
      const fallbackPath = path.join(process.cwd(), 'uploads', path.basename(videoPath));
      if (fs.existsSync(fallbackPath)) {
        localFilePath = fallbackPath;
      }
    }

    const tiktokPrivacy = privacyStatus === 'private' ? 'SELF_ONLY' : 'PUBLIC_TO_EVERYONE';

    // ── ATTEMPT 1: Direct Video Publish via PULL_FROM_URL ──
    if (remoteUrl) {
      try {
        console.log('[TIKTOK] Attempting Direct Publish (PULL_FROM_URL):', remoteUrl);
        const initRes = await axios.post<{
          data?: { publish_id: string };
          error?: { code: string; message: string };
        }>('https://open.tiktokapis.com/v2/post/publish/video/init/', {
          post_info: {
            title: captionText,
            privacy_level: tiktokPrivacy,
            disable_duet: false,
            disable_stitch: false,
            disable_comment: false,
          },
          source_info: {
            source: 'PULL_FROM_URL',
            video_url: remoteUrl,
          },
        }, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        });

        if (initRes.data?.data?.publish_id) {
          const publish_id = initRes.data.data.publish_id;
          console.log('[TIKTOK] Direct publish initiated successfully! publish_id:', publish_id);
          return {
            platformPostId: publish_id,
            platformUrl: `https://www.tiktok.com/`,
          };
        } else if (initRes.data?.error?.code && initRes.data.error.code !== 'ok') {
          console.warn('[TIKTOK] Direct publish error response:', initRes.data.error);
        }
      } catch (directErr: any) {
        console.warn('[TIKTOK] Direct PULL_FROM_URL failed:', directErr?.response?.data || directErr?.message);
      }
    }

    // ── ATTEMPT 2: Direct Video Publish via Local File Binary ──
    if (localFilePath) {
      try {
        console.log('[TIKTOK] Attempting Direct Publish (FILE_UPLOAD):', localFilePath);
        const fileSize = fs.statSync(localFilePath).size;
        const initRes = await axios.post<{
          data?: { publish_id: string; upload_url?: string };
          error?: { code: string; message: string };
        }>('https://open.tiktokapis.com/v2/post/publish/video/init/', {
          post_info: {
            title: captionText,
            privacy_level: tiktokPrivacy,
            disable_duet: false,
            disable_stitch: false,
            disable_comment: false,
          },
          source_info: {
            source: 'FILE_UPLOAD',
            video_size: fileSize,
            chunk_size: fileSize,
            total_chunk_count: 1,
          },
        }, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        });

        if (initRes.data?.data?.upload_url) {
          const { publish_id, upload_url } = initRes.data.data;
          const videoBuffer = fs.readFileSync(localFilePath);
          await axios.put(upload_url, videoBuffer, {
            headers: {
              'Content-Type': 'video/mp4',
              'Content-Range': `bytes 0-${fileSize - 1}/${fileSize}`,
              'Content-Length': fileSize,
            },
          });
          console.log('[TIKTOK] Direct binary upload successful! publish_id:', publish_id);
          return { platformPostId: publish_id, platformUrl: 'https://www.tiktok.com/' };
        }
      } catch (fileErr: any) {
        console.warn('[TIKTOK] Direct file upload failed:', fileErr?.response?.data || fileErr?.message);
      }
    }

    // ── ATTEMPT 3: Creator Inbox Draft Fallback (For Development / Sandbox Apps) ──
    try {
      console.log('[TIKTOK] Attempting Creator Inbox Draft fallback...');
      if (remoteUrl) {
        const inboxRes = await axios.post<{
          data?: { publish_id: string };
          error?: { code: string; message: string };
        }>('https://open.tiktokapis.com/v2/post/publish/inbox/video/init/', {
          source_info: {
            source: 'PULL_FROM_URL',
            video_url: remoteUrl,
          },
        }, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        });

        if (inboxRes.data?.data?.publish_id) {
          console.log('[TIKTOK] Inbox draft created via URL! publish_id:', inboxRes.data.data.publish_id);
          return { platformPostId: inboxRes.data.data.publish_id, platformUrl: 'https://www.tiktok.com/' };
        }
      }

      if (localFilePath) {
        const fileSize = fs.statSync(localFilePath).size;
        const inboxRes = await axios.post<{
          data?: { publish_id: string; upload_url?: string };
          error?: { code: string; message: string };
        }>('https://open.tiktokapis.com/v2/post/publish/inbox/video/init/', {
          source_info: {
            source: 'FILE_UPLOAD',
            video_size: fileSize,
            chunk_size: fileSize,
            total_chunk_count: 1,
          },
        }, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        });

        if (inboxRes.data?.data?.upload_url) {
          const { publish_id, upload_url } = inboxRes.data.data;
          const videoBuffer = fs.readFileSync(localFilePath);
          await axios.put(upload_url, videoBuffer, {
            headers: {
              'Content-Type': 'video/mp4',
              'Content-Range': `bytes 0-${fileSize - 1}/${fileSize}`,
              'Content-Length': fileSize,
            },
          });
          console.log('[TIKTOK] Inbox draft uploaded via binary! publish_id:', publish_id);
          return { platformPostId: publish_id, platformUrl: 'https://www.tiktok.com/' };
        }
      }
    } catch (inboxErr: any) {
      console.error('[TIKTOK] Inbox fallback failed:', inboxErr?.response?.data || inboxErr?.message);
      throw new Error(`TikTok Upload Failed: ${JSON.stringify(inboxErr?.response?.data || inboxErr?.message)}`);
    }

    throw new Error('TikTok upload failed: neither Direct Publish nor Inbox Draft succeeded.');
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
