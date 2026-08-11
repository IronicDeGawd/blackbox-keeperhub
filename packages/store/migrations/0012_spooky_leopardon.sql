CREATE TABLE IF NOT EXISTS "keeperhub_connections" (
	"org_id" text PRIMARY KEY NOT NULL,
	"refresh_token_enc" text NOT NULL,
	"scope" text NOT NULL,
	"subject" text,
	"connected_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_refreshed_at" timestamp with time zone,
	"last_swept_at" timestamp with time zone,
	"status" text NOT NULL,
	"last_error" text,
	"failure_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "watched_workflows" (
	"org_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"name" text,
	"active" boolean DEFAULT true NOT NULL,
	"connected_at" timestamp with time zone NOT NULL,
	"last_run_at" timestamp with time zone,
	CONSTRAINT "watched_workflows_org_id_workflow_id_pk" PRIMARY KEY("org_id","workflow_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "keeperhub_connections_status_idx" ON "keeperhub_connections" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "watched_workflows_org_idx" ON "watched_workflows" USING btree ("org_id");