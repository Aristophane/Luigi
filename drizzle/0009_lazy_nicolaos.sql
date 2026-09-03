CREATE TABLE "monitoring_heartbeats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source" text NOT NULL,
	"interval_seconds" integer NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "fingerprint" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "occurrence_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "last_occurred_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
UPDATE "notifications" SET "last_occurred_at" = "created_at";--> statement-breakpoint
ALTER TABLE "monitoring_heartbeats" ADD CONSTRAINT "monitoring_heartbeats_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "monitoring_heartbeats_workspace_source_unique" ON "monitoring_heartbeats" USING btree ("workspace_id","source");--> statement-breakpoint
CREATE INDEX "monitoring_heartbeats_workspace_idx" ON "monitoring_heartbeats" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "notifications_workspace_fingerprint_idx" ON "notifications" USING btree ("workspace_id","fingerprint");
