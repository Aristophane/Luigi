CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"token_digest" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"interval_seconds" integer DEFAULT 300 NOT NULL,
	"configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"outcome" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"serial_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"lock_token" uuid,
	"last_error" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notification_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"recipient" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"label" text NOT NULL,
	"hostname" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"name" text PRIMARY KEY NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "repository_commit_message" text;--> statement-breakpoint
ALTER TABLE "checks" ADD COLUMN "server_id" uuid;--> statement-breakpoint
ALTER TABLE "checks" ADD COLUMN "service_key" text;--> statement-breakpoint
ALTER TABLE "checks" ADD COLUMN "essential" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "checks" ADD COLUMN "status" "health_status" DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "checks" ADD COLUMN "last_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "checks" ADD COLUMN "next_check_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "server_id" uuid;--> statement-breakpoint
ALTER TABLE "vps_metric_samples" ADD COLUMN "server_id" uuid;--> statement-breakpoint
ALTER TABLE "vps_metric_samples" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "vps_metric_samples" ADD COLUMN "processed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vps_metric_samples" ADD COLUMN "processing_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "vps_metric_samples" ADD COLUMN "received_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "vps_storage_snapshots" ADD COLUMN "server_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_delivery_id_notification_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."notification_deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_token_unique" ON "agents" USING btree ("token_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_active_key_unique" ON "jobs" USING btree ("key") WHERE "jobs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("kind","status","available_at");--> statement-breakpoint
CREATE INDEX "jobs_serial_idx" ON "jobs" USING btree ("serial_key","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_recipient_unique" ON "notification_deliveries" USING btree ("notification_id","channel","recipient");--> statement-breakpoint
ALTER TABLE "checks" ADD CONSTRAINT "checks_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vps_metric_samples" ADD CONSTRAINT "vps_metric_samples_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vps_metric_samples" ADD CONSTRAINT "vps_metric_samples_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vps_storage_snapshots" ADD CONSTRAINT "vps_storage_snapshots_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Preserve the existing agent credentials and identity during the transition.
INSERT INTO servers (id, workspace_id, label, hostname, created_at)
SELECT id, workspace_id, label, configuration->>'hostname', created_at FROM integrations
WHERE kind = 'vps_agent';
--> statement-breakpoint
INSERT INTO agents (id, server_id, token_digest, enabled, configuration, last_seen_at, created_at)
SELECT (configuration->>'agentId')::uuid, id, encrypted_credentials, enabled, configuration, last_synced_at, created_at
FROM integrations WHERE kind = 'vps_agent' AND encrypted_credentials IS NOT NULL
AND configuration->>'agentId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
--> statement-breakpoint
UPDATE vps_metric_samples m SET server_id = s.id, agent_id = a.id, received_at = m.observed_at,
  processed_at = now(), processing_status = 'legacy'
FROM servers s JOIN agents a ON a.server_id = s.id WHERE m.workspace_id = s.workspace_id;
--> statement-breakpoint
UPDATE vps_storage_snapshots m SET server_id = s.id FROM servers s WHERE m.workspace_id = s.workspace_id;
--> statement-breakpoint
UPDATE findings f SET server_id = s.id, fingerprint = 'vps:' || s.id || ':' || substring(f.fingerprint from 5),
  metadata = f.metadata || jsonb_build_object('serverId', s.id)
FROM servers s WHERE f.workspace_id = s.workspace_id AND f.fingerprint LIKE 'vps:%';
--> statement-breakpoint
UPDATE notifications n SET fingerprint = 'finding:vps:' || s.id || ':' || substring(n.fingerprint from 13)
FROM servers s WHERE n.workspace_id = s.workspace_id AND n.fingerprint LIKE 'finding:vps:%';
--> statement-breakpoint
UPDATE monitoring_heartbeats h SET source = 'vps_agent:' || s.id
FROM servers s WHERE h.workspace_id = s.workspace_id AND h.source = 'vps_agent';
--> statement-breakpoint
UPDATE notifications n SET fingerprint = 'monitoring-source:vps_agent:' || s.id || ':silent'
FROM servers s WHERE n.workspace_id = s.workspace_id AND n.fingerprint = 'monitoring-source:vps_agent:silent';
--> statement-breakpoint
-- The scheduler is autonomous now; the optional cron is no longer a required source.
DELETE FROM monitoring_heartbeats WHERE source = 'monitor_cron';
--> statement-breakpoint
UPDATE notifications SET resolved_at = now() WHERE fingerprint = 'monitoring-source:monitor_cron:silent' AND resolved_at IS NULL;
--> statement-breakpoint
UPDATE integrations SET enabled = false WHERE kind = 'vps_agent';
--> statement-breakpoint
UPDATE checks c SET last_checked_at = o.observed_at, status = o.status
FROM (SELECT DISTINCT ON (check_id) check_id, observed_at, status FROM observations ORDER BY check_id, observed_at DESC) o
WHERE o.check_id = c.id;
--> statement-breakpoint
-- Replay a recent report atomically under the new rules; older history is retained as legacy evidence.
WITH latest AS (SELECT DISTINCT ON (agent_id) id FROM vps_metric_samples
  WHERE agent_id IS NOT NULL AND observed_at > now() - interval '10 minutes' ORDER BY agent_id, observed_at DESC)
UPDATE vps_metric_samples SET processed_at = NULL, processing_status = 'pending' WHERE id IN (SELECT id FROM latest);
--> statement-breakpoint
INSERT INTO jobs (workspace_id, kind, key, serial_key, payload)
SELECT workspace_id, 'report', 'report:' || id, 'agent:' || agent_id, jsonb_build_object('sampleId', id)
FROM vps_metric_samples WHERE processing_status = 'pending' AND agent_id IS NOT NULL;
--> statement-breakpoint
UPDATE storage_resource_mappings m SET resource_key = s.id || ':' || m.resource_key
FROM servers s WHERE m.workspace_id = s.workspace_id;
