CREATE TABLE "vps_agent_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"code_digest" text NOT NULL,
	"endpoint" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vps_agent_enrollments" ADD CONSTRAINT "vps_agent_enrollments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vps_agent_enrollments_code_unique" ON "vps_agent_enrollments" USING btree ("code_digest");--> statement-breakpoint
CREATE INDEX "vps_agent_enrollments_workspace_idx" ON "vps_agent_enrollments" USING btree ("workspace_id");