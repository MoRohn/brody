CREATE TABLE `explanations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`source_run_id` text NOT NULL,
	`source` text NOT NULL,
	`title` text NOT NULL,
	`audience` text NOT NULL,
	`spec` text NOT NULL,
	`spec_hash` text NOT NULL,
	`router` text,
	`compile` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `explanations_project_idx` ON `explanations` (`project_id`);--> statement-breakpoint
CREATE INDEX `explanations_source_idx` ON `explanations` (`project_id`,`source_run_id`);--> statement-breakpoint
CREATE TABLE `video_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`explanation_id` text NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`params` text NOT NULL,
	`stages` text DEFAULT '[]' NOT NULL,
	`current_stage` text,
	`stage_hashes` text DEFAULT '{}' NOT NULL,
	`progress` text,
	`artifacts` text DEFAULT '{}' NOT NULL,
	`manifest` text,
	`validation` text,
	`error` text,
	`log` text DEFAULT '[]' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`parent_job_id` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`heartbeat_at` integer,
	`cancel_requested` integer DEFAULT false NOT NULL,
	`summary` text
);
--> statement-breakpoint
CREATE INDEX `video_jobs_explanation_idx` ON `video_jobs` (`explanation_id`);--> statement-breakpoint
CREATE INDEX `video_jobs_status_idx` ON `video_jobs` (`status`);--> statement-breakpoint
CREATE INDEX `video_jobs_project_idx` ON `video_jobs` (`project_id`);