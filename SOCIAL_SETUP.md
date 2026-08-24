# GoViral Social Platform Setup Guide

## Overview

GoViral supports publishing to Instagram, TikTok, YouTube, and LinkedIn.
All OAuth and publishing happens on this backend server — the iOS app never sees tokens.

---

## 1. Platform Developer App Setup

### YouTube (No approval needed — start here)
1. Go to https://console.cloud.google.com/
2. Create a project named "GoViral"
3. Enable **YouTube Data API v3**
4. Create OAuth 2.0 credentials (Web Application)
5. Add authorized redirect URI: `https://api.goviral.app/api/social/youtube/callback`
6. Set in `.env`:
   ```
   YOUTUBE_CLIENT_ID=...
   YOUTUBE_CLIENT_SECRET=...
   YOUTUBE_REDIRECT_URI=https://api.goviral.app/api/social/youtube/callback
   ```

### Instagram / Meta (Requires App Review for publishing)
1. Go to https://developers.facebook.com/apps/
2. Create a new app → Business type
3. Add Instagram product
4. Add redirect URI: `https://api.goviral.app/api/social/instagram/callback`
5. Required permissions: `instagram_basic`, `instagram_content_publish`, `pages_show_list`
6. Submit for App Review for `instagram_content_publish` (takes 1-4 weeks)
7. Set in `.env`:
   ```
   INSTAGRAM_CLIENT_ID=...
   INSTAGRAM_CLIENT_SECRET=...
   INSTAGRAM_REDIRECT_URI=https://api.goviral.app/api/social/instagram/callback
   ```

**Note:** During development, use test users in the Meta App dashboard.

### TikTok (Requires Partner approval for video.publish)
1. Go to https://developers.tiktok.com/
2. Create an app → Apply for Login Kit + Content Posting API
3. Add redirect URI: `https://api.goviral.app/api/social/tiktok/callback`
4. Scopes: `user.info.basic`, `video.publish`, `video.upload`
5. Apply for Content Posting API access (partner review required)
6. Set in `.env`:
   ```
   TIKTOK_CLIENT_KEY=...
   TIKTOK_CLIENT_SECRET=...
   TIKTOK_REDIRECT_URI=https://api.goviral.app/api/social/tiktok/callback
   ```

### LinkedIn
1. Go to https://www.linkedin.com/developers/apps
2. Create an app
3. Add redirect URI: `https://api.goviral.app/api/social/linkedin/callback`
4. Scopes: `r_liteprofile`, `r_emailaddress`, `w_member_social`
5. Set in `.env`:
   ```
   LINKEDIN_CLIENT_ID=...
   LINKEDIN_CLIENT_SECRET=...
   LINKEDIN_REDIRECT_URI=https://api.goviral.app/api/social/linkedin/callback
   ```

---

## 2. Environment Setup

```bash
cp .env.example .env
# Fill in all values
```

Generate TOKEN_ENCRYPTION_KEY:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Generate JWT_SECRET:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

---

## 3. Database Setup

```bash
# Install PostgreSQL locally or use Railway/Supabase
npm install
npx prisma migrate dev --name init
npx prisma generate
```

---

## 4. Redis Setup (for Bull queue)

```bash
# macOS
brew install redis
brew services start redis

# Or use Railway Redis
```

---

## 5. Local Development

```bash
npm install
npm run dev
```

Server starts at http://localhost:3000

---

## 6. Testing OAuth

### YouTube (easiest — no approval)
1. Set YouTube credentials in `.env`
2. Start server: `npm run dev`
3. Open GoViral iOS app
4. Settings → Social Accounts → Connect YouTube
5. Sign in with Google
6. Account should show "Connected ✅"

### Instagram (sandbox)
1. In Meta App Dashboard, add test users
2. Test users can connect without App Review approval
3. Publishing works for test users only

### TikTok (sandbox)
1. TikTok developer sandbox allows `video.upload` (draft mode) without partner approval
2. Final publishing requires partner program

---

## 7. API Routes

```
GET  /health
GET  /api/social/:platform/connect      — returns { authorizationUrl, state }
GET  /api/social/:platform/callback     — OAuth callback, redirects to goviral://
POST /api/social/accounts/:id/disconnect
POST /api/social/accounts/:id/refresh
GET  /api/social/accounts               — returns { accounts: [...] }
POST /api/social/publish                — returns { jobs: [...] }
GET  /api/social/publish/jobs
GET  /api/social/publish/jobs/:id
```

---

## 8. Deployment (Railway — recommended)

```bash
# Install Railway CLI
npm i -g @railway/cli
railway login
railway init
railway up

# Add environment variables in Railway dashboard
# Add PostgreSQL + Redis plugins in Railway
```

Set `APP_URL` to your Railway deployment URL.
Update OAuth redirect URIs in each platform's developer console.

---

## 9. Platform Approval Requirements

| Platform  | What Needs Approval | Timeline  |
|-----------|--------------------|-----------| 
| YouTube   | Nothing           | Immediate |
| Instagram | instagram_content_publish | 1-4 weeks |
| TikTok    | Content Posting API Partner | 4-8 weeks |
| LinkedIn  | w_member_social (video) | 2-4 weeks |

GoViral account connection OAuth works immediately for all platforms.
Publishing is blocked until platform-specific approvals are granted.

---

## 10. Security Checklist

- [x] Client secrets server-side only
- [x] AES-256 token encryption at rest
- [x] OAuth CSRF state validation
- [x] JWT authentication on all endpoints
- [x] Tokens never returned to frontend
- [x] Tokens never logged
- [x] Rate limiting on OAuth and publish endpoints
- [x] User ownership validation on all account operations
- [x] Exponential backoff on failed jobs
