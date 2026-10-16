CREATE TABLE `images` (
	`hash` text PRIMARY KEY NOT NULL,
	`mime` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`data` blob NOT NULL,
	`meta` text NOT NULL
);
