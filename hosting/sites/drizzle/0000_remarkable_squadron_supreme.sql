CREATE TABLE `daily_usage` (
	`owner` text NOT NULL,
	`day` text NOT NULL,
	`runs` integer DEFAULT 0 NOT NULL,
	`nonce` text NOT NULL,
	PRIMARY KEY(`owner`, `day`)
);
--> statement-breakpoint
CREATE TABLE `public_usage` (
	`period` text PRIMARY KEY NOT NULL,
	`caps` text NOT NULL,
	`searches` integer DEFAULT 0 NOT NULL,
	`uploads` integer DEFAULT 0 NOT NULL,
	`requests` integer DEFAULT 0 NOT NULL,
	`questions` integer DEFAULT 0 NOT NULL,
	`busy` text
);
--> statement-breakpoint
CREATE TABLE `research_cases` (
	`owner` text NOT NULL,
	`id` text NOT NULL,
	`object_key` text NOT NULL,
	`revision` integer NOT NULL,
	`question` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`owner`, `id`)
);
--> statement-breakpoint
CREATE TABLE `usage_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`period` text NOT NULL,
	`owner` text NOT NULL,
	`allocation` text NOT NULL,
	`created_at` text NOT NULL,
	`released_at` text
);
--> statement-breakpoint
CREATE TABLE `watch_stores` (
	`owner` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`document` text NOT NULL
);
