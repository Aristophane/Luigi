ALTER TABLE "applications" ADD COLUMN "dependency_scan_coverage" jsonb;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "branch" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "environment" "environment";--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "verification_source" text;