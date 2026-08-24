/**
 * base.ts — SocialPlatformAdapter abstract interface
 * Every platform adapter implements this contract.
 */

export interface OAuthTokens {
  accessToken:  string;
  refreshToken?: string;
  expiresAt?:   Date;
  scopes?:      string[];
}

export interface PlatformAccountInfo {
  platformUserId:   string;
  platformUsername?: string;
  displayName:     string;
  profileImageUrl?: string;
}

export interface VideoPublishOptions {
  videoPath:    string;   // local file path
  videoUrl?:    string;   // public CDN / video URL
  title?:       string;
  caption?:     string;
  description?: string;
  hashtags?:    string[];
  tags?:        string[];
  privacyStatus?: string;
  scheduledAt?:  Date;
  commentary?:   string;
}

export interface PublishResult {
  platformPostId?: string;
  platformUrl?:    string;
}

export interface VideoValidation {
  supported: boolean;
  reason?:   string;
}

export abstract class SocialPlatformAdapter {
  abstract platform: string;

  /** Generate the OAuth authorization URL + state for this platform */
  abstract getAuthorizationUrl(state: string): string;

  /** Exchange authorization code for access + refresh tokens */
  abstract handleOAuthCallback(code: string): Promise<OAuthTokens>;

  /** Refresh an expired access token using the stored refresh token */
  abstract refreshAccessToken(refreshToken: string): Promise<OAuthTokens>;

  /** Fetch basic account info (username, display name, avatar) */
  abstract getAccountInfo(accessToken: string): Promise<PlatformAccountInfo>;

  /** Validate if the stored token is still active and valid */
  abstract validateConnection(accessToken: string): Promise<boolean>;

  /** Upload and publish a video to the platform */
  abstract uploadVideo(accessToken: string, options: VideoPublishOptions): Promise<PublishResult>;

  /** Check processing / publish status of an uploaded video */
  abstract getPublishStatus(accessToken: string, platformPostId: string): Promise<string>;

  /** Revoke token / disconnect account on the platform */
  abstract revokeConnection(accessToken: string): Promise<void>;

  /** Validate video specs before attempting upload */
  abstract validateVideo(path: string, durationSeconds: number, fileSizeBytes: number): VideoValidation;
}
