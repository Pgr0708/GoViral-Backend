/**
 * base.ts — SocialPlatformAdapter interface
 * All platform adapters implement this contract.
 */

export interface OAuthTokens {
  accessToken:   string;
  refreshToken?: string;
  expiresAt?:    Date;
  scopes?:       string[];
}

export interface PlatformAccountInfo {
  platformUserId:  string;
  platformUsername?: string;
  displayName:     string;
  profileImageUrl?: string;
}

export interface VideoPublishOptions {
  videoPath:    string;   // local file path
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

  /** Exchange the authorization code for tokens after OAuth callback */
  abstract handleOAuthCallback(code: string): Promise<OAuthTokens>;

  /** Refresh an expiring access token using the refresh token */
  abstract refreshAccessToken(refreshToken: string): Promise<OAuthTokens>;

  /** Fetch connected account info (username, display name, profile image) */
  abstract getAccountInfo(accessToken: string): Promise<PlatformAccountInfo>;

  /** Validate that a token is still active */
  abstract validateConnection(accessToken: string): Promise<boolean>;

  /** Upload and publish a video to the platform */
  abstract uploadVideo(accessToken: string, options: VideoPublishOptions): Promise<PublishResult>;

  /** Get publishing status for a post (for platforms with async publishing) */
  abstract getPublishStatus(accessToken: string, platformPostId: string): Promise<string>;

  /** Revoke the access token on the platform side */
  abstract revokeConnection(accessToken: string): Promise<void>;

  /** Validate video file meets platform requirements */
  abstract validateVideo(videoPath: string, durationSeconds: number, fileSizeBytes: number): VideoValidation;
}
