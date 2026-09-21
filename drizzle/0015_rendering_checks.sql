ALTER TABLE "checks" ADD COLUMN "expected_text" text;--> statement-breakpoint
ALTER TABLE "checks" ADD COLUMN "asset_probe" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "checks" ADD COLUMN "asset_url" text;