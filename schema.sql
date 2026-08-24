-- GoViral Backend MySQL Schema
-- Copy and paste this directly into Hostinger phpMyAdmin -> SQL tab

CREATE TABLE IF NOT EXISTS `social_accounts` (
  `id` VARCHAR(191) NOT NULL,
  `user_id` VARCHAR(191) NOT NULL,
  `platform` VARCHAR(191) NOT NULL,
  `platform_user_id` VARCHAR(191) NULL,
  `platform_username` VARCHAR(191) NULL,
  `display_name` VARCHAR(191) NOT NULL DEFAULT '',
  `profile_image_url` VARCHAR(191) NULL,
  `access_token_enc` TEXT NOT NULL,
  `refresh_token_enc` TEXT NULL,
  `token_expires_at` DATETIME(3) NULL,
  `scopes` JSON NULL,
  `metadata` JSON NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'connected',
  `last_error` TEXT NULL,
  `connected_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE KEY `social_accounts_user_id_platform_platform_user_id_key` (`user_id`, `platform`, `platform_user_id`),
  INDEX `social_accounts_user_id_platform_idx` (`user_id`, `platform`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `oauth_states` (
  `id` VARCHAR(191) NOT NULL,
  `state` VARCHAR(191) NOT NULL,
  `user_id` VARCHAR(191) NOT NULL,
  `platform` VARCHAR(191) NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `consumed` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE KEY `oauth_states_state_key` (`state`),
  INDEX `oauth_states_state_idx` (`state`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `social_publish_jobs` (
  `id` VARCHAR(191) NOT NULL,
  `user_id` VARCHAR(191) NOT NULL,
  `video_id` VARCHAR(191) NOT NULL,
  `social_account_id` VARCHAR(191) NOT NULL,
  `platform` VARCHAR(191) NOT NULL,
  `title` VARCHAR(191) NULL,
  `caption` TEXT NULL,
  `description` TEXT NULL,
  `hashtags` JSON NULL,
  `tags` JSON NULL,
  `metadata` JSON NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'queued',
  `scheduled_at` DATETIME(3) NULL,
  `started_at` DATETIME(3) NULL,
  `published_at` DATETIME(3) NULL,
  `platform_post_id` VARCHAR(191) NULL,
  `platform_url` VARCHAR(191) NULL,
  `error_code` VARCHAR(191) NULL,
  `error_message` TEXT NULL,
  `retry_count` INT NOT NULL DEFAULT 0,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  INDEX `social_publish_jobs_user_id_idx` (`user_id`),
  INDEX `social_publish_jobs_status_idx` (`status`),
  INDEX `social_publish_jobs_scheduled_at_idx` (`scheduled_at`),
  CONSTRAINT `social_publish_jobs_social_account_id_fkey` 
    FOREIGN KEY (`social_account_id`) REFERENCES `social_accounts` (`id`) 
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
