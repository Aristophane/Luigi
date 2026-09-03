CREATE TABLE "maintenance_task_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"previous_status" "task_status",
	"next_status" "task_status",
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "maintenance_tasks" ADD COLUMN "application_id" uuid;--> statement-breakpoint
ALTER TABLE "maintenance_task_events" ADD CONSTRAINT "maintenance_task_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_task_events" ADD CONSTRAINT "maintenance_task_events_task_id_maintenance_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."maintenance_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_task_events" ADD CONSTRAINT "maintenance_task_events_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "maintenance_task_events_workspace_idx" ON "maintenance_task_events" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "maintenance_task_events_task_time_idx" ON "maintenance_task_events" USING btree ("task_id","created_at");--> statement-breakpoint
ALTER TABLE "maintenance_tasks" ADD CONSTRAINT "maintenance_tasks_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "maintenance_tasks_application_idx" ON "maintenance_tasks" USING btree ("application_id");--> statement-breakpoint
UPDATE "maintenance_tasks" AS task
SET "application_id" = finding."application_id"
FROM "findings" AS finding
WHERE task."finding_id" = finding."id"
  AND finding."application_id" IS NOT NULL;--> statement-breakpoint
INSERT INTO "maintenance_task_events" (
	"workspace_id",
	"task_id",
	"action",
	"next_status",
	"note",
	"created_at"
)
SELECT
	"workspace_id",
	"id",
	'imported',
	"status",
	'Historique initial créé lors de l’activation du journal de maintenance.',
	COALESCE("completed_at", "created_at")
FROM "maintenance_tasks";
