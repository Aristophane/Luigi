CREATE TABLE "storage_resource_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"resource_key" text NOT NULL,
	"application_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vps_storage_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"hostname" text NOT NULL,
	"total_bytes" bigint NOT NULL,
	"used_bytes" bigint NOT NULL,
	"free_bytes" bigint NOT NULL,
	"scan_duration_ms" integer NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "storage_resource_mappings" ADD CONSTRAINT "storage_resource_mappings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_resource_mappings" ADD CONSTRAINT "storage_resource_mappings_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vps_storage_snapshots" ADD CONSTRAINT "vps_storage_snapshots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "storage_resource_mappings_workspace_resource_unique" ON "storage_resource_mappings" USING btree ("workspace_id","resource_key");--> statement-breakpoint
CREATE INDEX "storage_resource_mappings_application_idx" ON "storage_resource_mappings" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vps_storage_snapshots_snapshot_unique" ON "vps_storage_snapshots" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "vps_storage_snapshots_workspace_time_idx" ON "vps_storage_snapshots" USING btree ("workspace_id","observed_at");