/**
 * LinkedInAdapter — LinkedIn OAuth 2.0 (OpenID Connect) + Video/Post API
 *
 * OAuth: LinkedIn OpenID Connect (Sign In with LinkedIn)
 * Publishing: LinkedIn REST API (ugcPosts + video upload)
 *
 * Scopes: openid, profile, email, w_member_social
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import {
  SocialPlatformAdapter, OAuthTokens, PlatformAccountInfo,
  VideoPublishOptions, PublishResult, VideoValidation
} from './base';

const AUTH_BASE   = 'https://www.linkedin.com/oauth/v2/authorization';
const TOKEN_URL   = 'https://www.linkedin.com/oauth/v2/accessToken';
const API_BASE    = 'https://api.linkedin.com/v2';

const MAX_VIDEO_SIZE_BYTES = 5_000_000_000; // 5 GB
const MAX_DURATION_SECONDS = 600;           // 10 min

// Modern LinkedIn OpenID Connect + Sharing scopes
const SCOPES = ['openid', 'profile', 'email', 'w_member_social'].join(' ');

export class LinkedInAdapter extends SocialPlatformAdapter {
  platform = 'linkedin';

  private get clientId()     { return process.env.LINKEDIN_CLIENT_ID!; }
  private get clientSecret() { return process.env.LINKEDIN_CLIENT_SECRET!; }
  private get redirectUri()  { return process.env.LINKEDIN_REDIRECT_URI!; }

  getAuthorizationUrl(state: string): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id:     this.clientId,
      redirect_uri:  this.redirectUri,
      state,
      scope:         SCOPES,
    });
    return `${AUTH_BASE}?${params}`;
  }

  async handleOAuthCallback(code: string): Promise<OAuthTokens> {
    const res = await axios.post<{
      access_token: string; expires_in: number; refresh_token?: string
    }>(TOKEN_URL, new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      redirect_uri:  this.redirectUri,
      client_id:     this.clientId,
      client_secret: this.clientSecret,
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    return {
      accessToken:  res.data.access_token,
      refreshToken: res.data.refresh_token,
      expiresAt:    new Date(Date.now() + res.data.expires_in * 1000),
      scopes:       SCOPES.split(' '),
    };
  }

  async refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
    const res = await axios.post<{
      access_token: string; expires_in: number
    }>(TOKEN_URL, new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      client_id:     this.clientId,
      client_secret: this.clientSecret,
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    return {
      accessToken: res.data.access_token,
      expiresAt:   new Date(Date.now() + res.data.expires_in * 1000),
    };
  }

  async getAccountInfo(accessToken: string): Promise<PlatformAccountInfo> {
    try {
      const res = await axios.get<{
        sub: string;
        name?: string;
        given_name?: string;
        family_name?: string;
        picture?: string;
      }>(`${API_BASE}/userinfo`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      const displayName = res.data.name || `${res.data.given_name ?? ''} ${res.data.family_name ?? ''}`.trim() || 'LinkedIn User';

      return {
        platformUserId:  res.data.sub,
        displayName,
        profileImageUrl: res.data.picture,
      };
    } catch {
      const res = await axios.get<{ id: string; localizedFirstName?: string; localizedLastName?: string }>(`${API_BASE}/me`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      return {
        platformUserId: res.data.id,
        displayName:    `${res.data.localizedFirstName ?? ''} ${res.data.localizedLastName ?? ''}`.trim() || 'LinkedIn User',
      };
    }
  }

  async validateConnection(accessToken: string): Promise<boolean> {
    try {
      await axios.get(`${API_BASE}/userinfo`, { headers: { Authorization: `Bearer ${accessToken}` } });
      return true;
    } catch { return false; }
  }

  /**
   * LinkedIn video publish flow:
   * 1. Register upload
   * 2. Upload video binary
   * 3. Create ugcPost with the video asset
   */
  async uploadVideo(accessToken: string, options: VideoPublishOptions): Promise<PublishResult> {
    const { commentary = '', caption = '', hashtags = [], videoPath, videoUrl } = options;
    const text = commentary || caption;
    const hashtagText = hashtags.map(h => h.startsWith('#') ? h : `#${h}`).join(' ');
    const postText = [text, hashtagText].filter(Boolean).join('\n\n');

    const accountInfo = await this.getAccountInfo(accessToken);
    const authorUrn = `urn:li:person:${accountInfo.platformUserId}`;

    // Step 1: Register video upload
    const registerRes = await axios.post<{
      value: {
        uploadMechanism: { 'com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest': { uploadUrl: string } };
        asset: string;
      }
    }>(`${API_BASE}/assets?action=registerUpload`, {
      registerUploadRequest: {
        recipes:    ['urn:li:digitalmediaRecipe:feedshare-video'],
        owner:      authorUrn,
        serviceRelationships: [{
          relationshipType: 'OWNER',
          identifier:       'urn:li:userGeneratedContent',
        }],
      },
    }, { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } });

    const uploadUrl = registerRes.data.value.uploadMechanism['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'].uploadUrl;
    const assetUrn  = registerRes.data.value.asset;

    // Step 2: Upload binary (local file, uploads folder, or download remote arraybuffer)
    let fileBuffer: Buffer;
    if (videoPath && fs.existsSync(videoPath)) {
      fileBuffer = fs.readFileSync(videoPath);
    } else if (videoPath && fs.existsSync(path.join(process.cwd(), 'uploads', path.basename(videoPath)))) {
      fileBuffer = fs.readFileSync(path.join(process.cwd(), 'uploads', path.basename(videoPath)));
    } else if (videoUrl || (videoPath && videoPath.startsWith('http'))) {
      const targetUrl = videoUrl || videoPath;
      const downloadRes = await axios.get(targetUrl, { responseType: 'arraybuffer' });
      fileBuffer = Buffer.from(downloadRes.data);
    } else {
      throw new Error(`LinkedIn uploadVideo: no valid file found for videoPath=${videoPath}`);
    }

    await axios.put(uploadUrl, fileBuffer, {
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/octet-stream' },
    });

    // Step 3: Create post
    const postRes = await axios.post<{ id: string }>(`${API_BASE}/ugcPosts`, {
      author:         authorUrn,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text: postText },
          shareMediaCategory: 'VIDEO',
          media: [{
            status: 'READY',
            media:  assetUrn,
          }],
        },
      },
      visibility: {
        'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
      },
    }, { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } });

    return {
      platformPostId: postRes.data.id,
      platformUrl:    `https://www.linkedin.com/feed/update/${postRes.data.id}/`,
    };
  }

  async getPublishStatus(_accessToken: string, _platformPostId: string): Promise<string> {
    return 'published';
  }

  async revokeConnection(_accessToken: string): Promise<void> {
    // LinkedIn handles revocation via user account settings
  }

  validateVideo(_path: string, durationSeconds: number, fileSizeBytes: number): VideoValidation {
    if (fileSizeBytes > MAX_VIDEO_SIZE_BYTES) return { supported: false, reason: 'Exceeds LinkedIn 5 GB limit' };
    if (durationSeconds > MAX_DURATION_SECONDS) return { supported: false, reason: 'Exceeds LinkedIn 10-minute limit' };
    return { supported: true };
  }
}
