CREATE TYPE "public"."dependency_status" AS ENUM('current', 'outdated', 'unknown', 'unsupported');--> statement-breakpoint
CREATE TABLE "dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"ecosystem" text NOT NULL,
	"name" text NOT NULL,
	"current_version" text,
	"requested_range" text NOT NULL,
	"latest_version" text,
	"status" "dependency_status" DEFAULT 'unknown' NOT NULL,
	"direct" boolean DEFAULT true NOT NULL,
	"development" boolean DEFAULT false NOT NULL,
	"evidence" text NOT NULL,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "repository_commit" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "last_repository_scanned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dependencies" ADD CONSTRAINT "dependencies_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dependencies_application_ecosystem_name_unique" ON "dependencies" USING btree ("application_id","ecosystem","name");--> statement-breakpoint
CREATE INDEX "dependencies_application_idx" ON "dependencies" USING btree ("application_id");