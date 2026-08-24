# GoViral Social Platform Integration — Complete File & Code Changes

This document contains the complete list of all files created, modified, and configured for the **Social Platform Integration System (Instagram, TikTok, YouTube, LinkedIn)** across both the **iOS Frontend** and the **Node.js Backend**.

---

## Part 1: iOS Frontend (`GoViral/`)

### 1. [NEW] `GoViral/SocialAccount.swift`
* **Purpose**: Core models for social accounts, platform enums, capabilities, publish job tracking, and per-platform metadata.
* **Key Components**:
  * `enum SocialPlatform`: `instagram`, `tiktok`, `youtube`, `linkedin` with branding colors & gradients.
  * `enum SocialAccountStatus`: `connected`, `disconnected`, `reauthorizationRequired`, `error`.
  * `struct SocialAccount`: Safe representation of connected accounts (no raw tokens on device).
  * `struct SocialPublishMetadata`: Per-platform captions, hashtags, YouTube tags/privacy, LinkedIn commentary.
  * `struct SocialPublishJob`: Async upload job tracking with live status (`queued`, `processing`, `published`, `failed`).

---

### 2. [NEW] `GoViral/SocialAccountManager.swift`
* **Purpose**: Centralized `@MainActor` singleton managing social accounts, OAuth, API calls, and publish job polling.
* **Key Components**:
  * `connect(platform:)`: Initiates OAuth via `ASWebAuthenticationSession` (in-app browser).
  * `fetchAccounts()`: Calls `GET /api/social/accounts` and updates `@Published var connectedAccounts`.
  * `disconnect(account:)`: Calls `POST /api/social/accounts/:id/disconnect`.
  * `publish(videoId:socialAccountIds:metadata:)`: Calls `POST /api/social/publish` to create background jobs.
  * `startPollingJob(jobId:)`: Background poller with exponential backoff for live job tracking.

---

### 3. [NEW] `GoViral/SocialAccountsSettingsSection.swift`
* **Purpose**: Settings UI section displaying all 4 platforms with Connect, Disconnect, and Reconnect actions.
* **Key Components**:
  * `SocialPlatformRow`: Displays branded gradient icon, username, connection badge, and action button.
  * Confirmation dialog on Disconnect.

---

### 4. [NEW] `GoViral/SocialPublishPickerView.swift`
* **Purpose**: Reusable SwiftUI publish component embeddable in any feature (Clips, Export, Video Editor).
* **Key Components**:
  * Multi-platform checkbox selector.
  * Inline expandable metadata editors for captions, hashtags, and YouTube privacy/tags.
  * One-tap Publish button with live status indicator and direct links to published posts.

---

### 5. [MODIFIED] `GoViral/Apis.swift`
* **Changes**: Added live Hostinger backend endpoint & auth token holder:
  ```swift
  nonisolated(unsafe) static var goViralBackendURL = "https://goviral.dakshyaminfotech.store"
  nonisolated(unsafe) static var userAuthToken = ""
  ```

---

### 6. [MODIFIED] `GoViral/GoViralApp.swift`
* **Changes**: Registered `SocialAccountManager.shared` as `@StateObject` and injected into the SwiftUI environment:
  ```swift
  @StateObject private var socialManager = SocialAccountManager.shared
  ...
  .environmentObject(socialManager)
  ```

---

### 7. [MODIFIED] `GoViral/SettingsAndStorageView.swift`
* **Changes**: Inserted `SocialAccountsSettingsSection()` into Section 3 of the Settings tab.

---

### 8. [MODIFIED] `GoViral/VideoToClipsView.swift`
* **Changes**:
  * Added **📤 Publish** toggle button and embedded `SocialPublishPickerView` directly into `ClipResultCard`.
  * Fixed `ExtractedClip` with default property initializers (`caption = ""`, `hashtags = []`).
  * Fixed `GPTClipSegment` and fallback candidate generation calls.

---

### 9. [MODIFIED] `GoViral/AppDelegate.swift`
* **Changes**: Added `application(_:open:options:)` handler for `goviral://` OAuth callback deep links.

---

### 10. [MODIFIED] `GoViral/Info.plist`
* **Changes**: Registered the `goviral` custom URL scheme (`CFBundleURLTypes`).

---

### 11. [MODIFIED] `GoViral/AppStorageKeys.swift`
* **Changes**: Added `static let socialAccountsJSON = "socialAccountsJSON"` for caching connected accounts.

---

## Part 2: Backend Server (`goviral-backend/`)

Repository: `https://github.com/Pgr0708/GoViral-Backend`

### 1. `src/server.ts`
* Express server entrypoint with Helmet, CORS, Morgan logging, rate-limiting, and health check route (`/health`).
* Boots the Bull publish worker.

---

### 2. `src/routes/social.ts`
* Express API router for all social endpoints:
  * `GET  /api/social/:platform/connect`
  * `GET  /api/social/:platform/callback`
  * `GET  /api/social/accounts`
  * `POST /api/social/accounts/:id/disconnect`
  * `POST /api/social/accounts/:id/refresh`
  * `POST /api/social/publish`
  * `GET  /api/social/publish/jobs`
  * `GET  /api/social/publish/jobs/:id`

---

### 3. Platform Adapters (`src/adapters/`)
* **`base.ts`**: `SocialPlatformAdapter` abstract interface.
* **`youtube.ts`**: Google OAuth 2.0 + YouTube Data API v3 video upload.
* **`instagram.ts`**: Meta OAuth + Instagram Graph API Reels publishing.
* **`tiktok.ts`**: TikTok Login Kit v2 + Content Posting API.
* **`linkedin.ts`**: LinkedIn OAuth + UGC Posts video upload.
* **`index.ts`**: Adapter registry and factory.

---

### 4. Services (`src/services/`)
* **`tokenEncryption.ts`**: AES-256-GCM encryption & decryption for OAuth tokens at rest.
* **`socialAccountService.ts`**: Account CRUD, CSRF state generation, and automatic token refresh.
* **`publishingService.ts`**: Bull queue job creation and status queries.
* **`logger.ts`**: Winston structured logging (redacts secrets & raw tokens).

---

### 5. Worker (`src/workers/publishWorker.ts`)
* Bull background worker processing upload jobs with exponential backoff (30s → 1m → 2m → 4m → 8m).

---

### 6. Database (`prisma/schema.prisma` & `schema.sql`)
* MySQL schema defining:
  * `social_accounts` (encrypted tokens, account status, user mapping)
  * `oauth_states` (CSRF tokens with 15-min expiration)
  * `social_publish_jobs` (async video upload tracking)

---

### 7. Documentation & Configuration
* **`SOCIAL_SETUP.md`**: Complete developer console guide for Google Cloud, Meta, TikTok, and LinkedIn.
* **`schema.sql`**: Raw SQL script for phpMyAdmin.
* **`.env.example`**: Environment variables template.
* **`tsconfig.json` & `package.json`**: TypeScript and Node.js dependencies configuration.

---

## Part 3: How to Deploy to Another Laptop

1. **iOS Code**:
   * Pull the latest `GoViral` commit on your other laptop.
   * Open `GoViral.xcodeproj` in Xcode and press `Cmd + B` to build.

2. **Backend Code**:
   * Clone or pull `https://github.com/Pgr0708/GoViral-Backend`.
   * Run `npm install && npm run build`.
   * Copy `.env.example` to `.env` and fill in your API credentials.
