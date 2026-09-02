ALTER TABLE "vps_metric_samples" ADD COLUMN "report_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "vps_metric_samples" ADD COLUMN "hostname" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "vps_metric_samples_report_unique" ON "vps_metric_samples" USING btree ("report_id");