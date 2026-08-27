/**
 * TikTokAdapter — TikTok Login Kit + Content Posting API v2
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

const AUTH_BASE     = 'https://www.tiktok.com/v2/auth/authorize/';
const TOKEN_URL     = 'https://open.tiktokapis.com/v2/oauth/token/';
const USER_INFO_URL = 'https://open.tiktokapis.com/v2/user/info/';
const CREATOR_INFO_URL = 'https://open.tiktokapis.com/v2/post/publish/creator_info/query/';

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
   * Queries creator info to obtain creator's allowed privacy levels and posting capabilities
   */
  private async queryCreatorInfo(accessToken: string): Promise<{
    allowedPrivacyLevels: string[];
    maxDurationSec: number;
  }> {
    try {
      const res = await axios.post(CREATOR_INFO_URL, {}, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      });

      const data = res.data?.data;
      if (data) {
        return {
          allowedPrivacyLevels: data.privacy_level_options || ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'],
          maxDurationSec: data.max_video_post_duration_sec || 600,
        };
      }
    } catch (err: any) {
      console.warn('[TIKTOK] queryCreatorInfo notice:', err?.response?.data || err?.message);
    }
    return {
      allowedPrivacyLevels: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'],
      maxDurationSec: 600,
    };
  }

  /**
   * TikTok Direct Binary Upload (FILE_UPLOAD)
   * Bypasses TikTok URL Ownership Verification rules entirely by directly pushing the video binary.
   */
  async uploadVideo(accessToken: string, options: VideoPublishOptions): Promise<PublishResult> {
    const { caption = '', hashtags = [], videoPath, videoUrl, privacyStatus = 'public' } = options;
    const captionText = [caption, ...hashtags.map(h => h.startsWith('#') ? h : `#${h}`)].join(' ').slice(0, 150);

    const remoteUrl = videoUrl || (videoPath?.startsWith('http') ? videoPath : undefined);

    // 1. Obtain video binary buffer (from local disk or download from CDN)
    let videoBuffer: Buffer;
    if (videoPath && fs.existsSync(videoPath)) {
      videoBuffer = fs.readFileSync(videoPath);
    } else if (videoPath && fs.existsSync(path.join(process.cwd(), 'uploads', path.basename(videoPath)))) {
      videoBuffer = fs.readFileSync(path.join(process.cwd(), 'uploads', path.basename(videoPath)));
    } else if (remoteUrl) {
      console.log('[TIKTOK] Downloading video buffer from CDN for direct FILE_UPLOAD:', remoteUrl);
      const res = await axios.get(remoteUrl, { responseType: 'arraybuffer' });
      videoBuffer = Buffer.from(res.data);
    } else {
      throw new Error(`TikTok upload: no video file or URL found for videoPath=${videoPath}`);
    }

    const fileSize = videoBuffer.length;
    console.log('[TIKTOK] Video buffer ready. Total size:', fileSize, 'bytes');

    // 2. Query creator info for allowed privacy levels
    const creatorInfo = await this.queryCreatorInfo(accessToken);
    let chosenPrivacy = 'PUBLIC_TO_EVERYONE';
    if (privacyStatus === 'private' || !creatorInfo.allowedPrivacyLevels.includes('PUBLIC_TO_EVERYONE')) {
      chosenPrivacy = creatorInfo.allowedPrivacyLevels.includes('SELF_ONLY') ? 'SELF_ONLY' : creatorInfo.allowedPrivacyLevels[0] || 'SELF_ONLY';
    }

    let lastError: any = null;

    // ── METHOD 1: Direct Video Publish via FILE_UPLOAD ──
    try {
      console.log('[TIKTOK] Initializing Direct Post via FILE_UPLOAD...', { privacy: chosenPrivacy });
      const initRes = await axios.post('https://open.tiktokapis.com/v2/post/publish/video/init/', {
        post_info: {
          title: captionText,
          privacy_level: chosenPrivacy,
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

      const data = initRes.data?.data;
      if (data?.upload_url) {
        console.log('[TIKTOK] Upload URL received from TikTok. Uploading binary chunk...');
        await axios.put(data.upload_url, videoBuffer, {
          headers: {
            'Content-Type': 'video/mp4',
            'Content-Range': `bytes 0-${fileSize - 1}/${fileSize}`,
            'Content-Length': fileSize,
          },
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
        });

        console.log('[TIKTOK] Video binary uploaded to TikTok successfully! publish_id:', data.publish_id);
        return {
          platformPostId: data.publish_id,
          platformUrl: 'https://www.tiktok.com/',
        };
      } else if (initRes.data?.error?.code && initRes.data.error.code !== 'ok') {
        lastError = initRes.data.error;
        console.warn('[TIKTOK] Direct FILE_UPLOAD rejected by TikTok:', lastError);
      }
    } catch (err: any) {
      lastError = err?.response?.data || err?.message;
      console.warn('[TIKTOK] Direct FILE_UPLOAD error:', lastError);
    }

    // ── METHOD 2: Creator Inbox Draft via FILE_UPLOAD (Fallback for Sandbox Apps) ──
    try {
      console.log('[TIKTOK] Initializing Inbox Draft via FILE_UPLOAD...');
      const inboxRes = await axios.post('https://open.tiktokapis.com/v2/post/publish/inbox/video/init/', {
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

      const inboxData = inboxRes.data?.data;
      if (inboxData?.upload_url) {
        console.log('[TIKTOK] Upload URL received for Inbox Draft. Uploading binary chunk...');
        await axios.put(inboxData.upload_url, videoBuffer, {
          headers: {
            'Content-Type': 'video/mp4',
            'Content-Range': `bytes 0-${fileSize - 1}/${fileSize}`,
            'Content-Length': fileSize,
          },
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
        });

        console.log('[TIKTOK] Inbox draft uploaded to TikTok successfully! publish_id:', inboxData.publish_id);
        return {
          platformPostId: inboxData.publish_id,
          platformUrl: 'https://www.tiktok.com/',
        };
      } else if (inboxRes.data?.error?.code && inboxRes.data.error.code !== 'ok') {
        lastError = inboxRes.data.error;
        console.warn('[TIKTOK] Inbox FILE_UPLOAD rejected:', lastError);
      }
    } catch (err: any) {
      lastError = err?.response?.data || err?.message;
      console.error('[TIKTOK] Inbox FILE_UPLOAD error:', lastError);
    }

    throw new Error(`TikTok Publishing Failed: ${JSON.stringify(lastError ?? 'Unknown error')}`);
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
