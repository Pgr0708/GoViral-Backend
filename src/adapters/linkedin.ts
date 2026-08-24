/**
 * LinkedInAdapter — LinkedIn OAuth 2.0 + Video/Post API
 *
 * OAuth: LinkedIn OAuth 2.0
 * Publishing: LinkedIn REST API (ugcPosts + video upload)
 *
 * Scopes: r_liteprofile, r_emailaddress, w_member_social
 * Note: Video upload requires LinkedIn Partner approval.
 *       Without it, posts text-only or with external video link.
 */

import axios from 'axios';
import fs from 'fs';
import {
  SocialPlatformAdapter, OAuthTokens, PlatformAccountInfo,
  VideoPublishOptions, PublishResult, VideoValidation
} from './base';

const AUTH_BASE   = 'https://www.linkedin.com/oauth/v2/authorization';
const TOKEN_URL   = 'https://www.linkedin.com/oauth/v2/accessToken';
const API_BASE    = 'https://api.linkedin.com/v2';

const MAX_VIDEO_SIZE_BYTES = 5_000_000_000; // 5 GB
const MAX_DURATION_SECONDS = 600;           // 10 min

const SCOPES = ['r_liteprofile', 'r_emailaddress', 'w_member_social'].join(' ');

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
    const res = await axios.get<{
      id: string;
      localizedFirstName: string;
      localizedLastName: string;
      profilePicture?: { 'displayImage~': { elements: Array<{ identifiers: Array<{ identifier: string }> }> } }
    }>(`${API_BASE}/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params:  { projection: '(id,localizedFirstName,localizedLastName,profilePicture(displayImage~:playableStreams))' },
    });

    const profileUrl = res.data.profilePicture?.['displayImage~']?.elements?.[0]?.identifiers?.[0]?.identifier;

    return {
      platformUserId: res.data.id,
      displayName:    `${res.data.localizedFirstName} ${res.data.localizedLastName}`,
      profileImageUrl: profileUrl,
    };
  }

  async validateConnection(accessToken: string): Promise<boolean> {
    try {
      await axios.get(`${API_BASE}/me`, { headers: { Authorization: `Bearer ${accessToken}` } });
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
    const { commentary = '', caption = '', hashtags = [], videoPath } = options;
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

    // Step 2: Upload binary
    const fileBuffer = fs.readFileSync(videoPath);
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
        'com.linkedin.ugc.MemberNetworkVisibility': options.commentary ? 'PUBLIC' : 'PUBLIC',
      },
    }, { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } });

    return {
      platformPostId: postRes.data.id,
      platformUrl:    `https://www.linkedin.com/feed/update/${postRes.data.id}/`,
    };
  }

  async getPublishStatus(_accessToken: string, _platformPostId: string): Promise<string> {
    return 'published'; // LinkedIn posts are synchronous
  }

  async revokeConnection(_accessToken: string): Promise<void> {
    // LinkedIn doesn't have a token revocation endpoint; handle via developer portal
  }

  validateVideo(_path: string, durationSeconds: number, fileSizeBytes: number): VideoValidation {
    if (fileSizeBytes > MAX_VIDEO_SIZE_BYTES) return { supported: false, reason: 'Exceeds LinkedIn 5 GB limit' };
    if (durationSeconds > MAX_DURATION_SECONDS) return { supported: false, reason: 'Exceeds LinkedIn 10-minute limit' };
    return { supported: true };
  }
}
