DROP INDEX "dependencies_application_ecosystem_name_unique";--> statement-breakpoint
ALTER TABLE "dependencies" ADD COLUMN "manifest_path" text DEFAULT 'package.json' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "dependencies_application_ecosystem_manifest_name_unique" ON "dependencies" USING btree ("application_id","ecosystem","manifest_path","name");