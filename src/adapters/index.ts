import { SocialPlatformAdapter } from './base';
import { InstagramAdapter } from './instagram';
import { TikTokAdapter }   from './tiktok';
import { YouTubeAdapter }  from './youtube';
import { LinkedInAdapter } from './linkedin';

const adapters: Record<string, SocialPlatformAdapter> = {
  instagram: new InstagramAdapter(),
  tiktok:    new TikTokAdapter(),
  youtube:   new YouTubeAdapter(),
  linkedin:  new LinkedInAdapter(),
};

export const SUPPORTED_PLATFORMS = Object.keys(adapters);

export function getAdapter(platform: string): SocialPlatformAdapter {
  const adapter = adapters[platform];
  if (!adapter) throw new Error(`Unsupported platform: ${platform}`);
  return adapter;
}
