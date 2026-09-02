ALTER TABLE "checks" ADD COLUMN "failure_threshold" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "checks" ADD COLUMN "latency_warning_ms" integer DEFAULT 1500 NOT NULL;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "check_id" uuid;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_check_id_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."checks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "incidents_check_idx" ON "incidents" USING btree ("check_id");