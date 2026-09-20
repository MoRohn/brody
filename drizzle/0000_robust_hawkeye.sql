CREATE TABLE `blobs` (
	`hash` text PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`size` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `credentials` (
	`project_id` text PRIMARY KEY NOT NULL,
	`encrypted` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `explain_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`path` text NOT NULL,
	`name` text NOT NULL,
	`directory` text NOT NULL,
	`extension` text NOT NULL,
	`language` text NOT NULL,
	`size` integer NOT NULL,
	`lines` integer DEFAULT 0 NOT NULL,
	`hash` text NOT NULL,
	`classification` text NOT NULL,
	`is_binary` integer DEFAULT false NOT NULL,
	`is_test` integer DEFAULT false NOT NULL,
	`is_generated` integer DEFAULT false NOT NULL,
	`is_vendor` integer DEFAULT false NOT NULL,
	`is_excluded` integer DEFAULT false NOT NULL,
	`exclude_reason` text,
	`is_large` integer DEFAULT false NOT NULL,
	`has_content` integer DEFAULT true NOT NULL,
	`duplicate_of` text,
	`imports` text DEFAULT '[]' NOT NULL,
	`exports` text DEFAULT '[]' NOT NULL,
	`parse_status` text DEFAULT 'pending' NOT NULL,
	`parse_error` text,
	`module` text,
	`area` text,
	`role` text,
	`importance` real DEFAULT 0 NOT NULL,
	`explanation` text
);
--> statement-breakpoint
CREATE INDEX `files_project_idx` ON `files` (`project_id`);--> statement-breakpoint
CREATE INDEX `files_project_path_idx` ON `files` (`project_id`,`path`);--> statement-breakpoint
CREATE TABLE `findings` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`code` text NOT NULL,
	`title` text NOT NULL,
	`category` text NOT NULL,
	`severity` text NOT NULL,
	`confidence` text NOT NULL,
	`origin` text NOT NULL,
	`analyzer` text,
	`file_path` text,
	`start_line` integer,
	`end_line` integer,
	`evidence` text,
	`what_happens` text NOT NULL,
	`why_it_matters` text NOT NULL,
	`business_impact` text,
	`remediation` text NOT NULL,
	`patch` text,
	`related_components` text DEFAULT '[]' NOT NULL,
	`verification` text DEFAULT 'needs_verification' NOT NULL,
	`verification_note` text,
	`area` text
);
--> statement-breakpoint
CREATE INDEX `findings_project_idx` ON `findings` (`project_id`);--> statement-breakpoint
CREATE TABLE `index_entries` (
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`ref_id` text NOT NULL,
	`file_path` text,
	`title` text NOT NULL,
	`terms` text NOT NULL,
	`text` text NOT NULL,
	`embedding` text,
	PRIMARY KEY(`project_id`, `kind`, `ref_id`)
);
--> statement-breakpoint
CREATE INDEX `index_project_idx` ON `index_entries` (`project_id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`status` text NOT NULL,
	`stages` text DEFAULT '[]' NOT NULL,
	`current_stage` text,
	`error` text,
	`log` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`heartbeat_at` integer,
	`cancel_requested` integer DEFAULT false NOT NULL,
	`summary` text
);
--> statement-breakpoint
CREATE INDEX `jobs_project_idx` ON `jobs` (`project_id`);--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`);--> statement-breakpoint
CREATE TABLE `parse_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`source_type` text NOT NULL,
	`source_url` text,
	`owner` text,
	`branch` text,
	`commit` text,
	`source_hash` text NOT NULL,
	`file_count` integer DEFAULT 0 NOT NULL,
	`source_file_count` integer DEFAULT 0 NOT NULL,
	`total_bytes` integer DEFAULT 0 NOT NULL,
	`line_count` integer DEFAULT 0 NOT NULL,
	`languages` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'created' NOT NULL,
	`analysis` text,
	`incremental` text,
	`previous_project_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `questions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`question` text NOT NULL,
	`answer` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `questions_project_idx` ON `questions` (`project_id`);--> statement-breakpoint
CREATE TABLE `relationships` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`file_path` text,
	`line` integer,
	`confidence` real DEFAULT 1 NOT NULL,
	`meta` text
);
--> statement-breakpoint
CREATE INDEX `rel_project_idx` ON `relationships` (`project_id`);--> statement-breakpoint
CREATE INDEX `rel_source_idx` ON `relationships` (`source_id`);--> statement-breakpoint
CREATE INDEX `rel_target_idx` ON `relationships` (`target_id`);--> statement-breakpoint
CREATE TABLE `symbols` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`file_id` text NOT NULL,
	`file_path` text NOT NULL,
	`name` text NOT NULL,
	`qualified_name` text NOT NULL,
	`kind` text NOT NULL,
	`start_line` integer NOT NULL,
	`end_line` integer NOT NULL,
	`signature` text,
	`visibility` text DEFAULT 'internal' NOT NULL,
	`parent_id` text,
	`documentation` text,
	`exported` integer DEFAULT false NOT NULL,
	`meta` text,
	`inbound_count` integer DEFAULT 0 NOT NULL,
	`outbound_count` integer DEFAULT 0 NOT NULL,
	`importance` real DEFAULT 0 NOT NULL,
	`explanation` text
);
--> statement-breakpoint
CREATE INDEX `symbols_project_idx` ON `symbols` (`project_id`);--> statement-breakpoint
CREATE INDEX `symbols_file_idx` ON `symbols` (`file_id`);--> statement-breakpoint
CREATE INDEX `symbols_name_idx` ON `symbols` (`project_id`,`name`);