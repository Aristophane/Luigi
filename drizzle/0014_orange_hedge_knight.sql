CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"deployment_id" text NOT NULL,
	"commit_sha" text NOT NULL,
	"source" text DEFAULT 'ci' NOT NULL,
	"source_url" text,
	"deployed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deployments_application_source_event_unique" ON "deployments" USING btree ("application_id","source","deployment_id");--> statement-breakpoint
CREATE INDEX "deployments_application_time_idx" ON "deployments" USING btree ("application_id","deployed_at");--> statement-breakpoint
CREATE INDEX "deployments_workspace_time_idx" ON "deployments" USING btree ("workspace_id","deployed_at");