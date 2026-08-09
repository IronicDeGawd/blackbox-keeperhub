CREATE TABLE IF NOT EXISTS "execution_events" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"logical_action_id" text NOT NULL,
	"attempt_index" integer NOT NULL,
	"agent_id" text NOT NULL,
	"signer" text NOT NULL,
	"chain_id" integer NOT NULL,
	"tx_hash" text,
	"nonce" integer,
	"submitted_at" timestamp with time zone NOT NULL,
	"outcome_status" text NOT NULL,
	"block_number" bigint,
	"simulation_success" boolean,
	"trigger" jsonb NOT NULL,
	"simulation" jsonb NOT NULL,
	"submission" jsonb NOT NULL,
	"outcome" jsonb NOT NULL,
	"raw" jsonb,
	"ingested_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"class" text NOT NULL,
	"severity" text NOT NULL,
	"status" text NOT NULL,
	"agent_id" text NOT NULL,
	"signer" text NOT NULL,
	"chain_id" integer NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"first_event_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"rule_id" text NOT NULL,
	"confidence" real NOT NULL,
	"evidence" jsonb NOT NULL,
	"rca" jsonb,
	"remediation" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ingest_cursors" (
	"source" text PRIMARY KEY NOT NULL,
	"cursor" text,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signer_state" (
	"signer" text NOT NULL,
	"chain_id" integer NOT NULL,
	"consecutive_gap_polls" integer DEFAULT 0 NOT NULL,
	"last_polled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "execution_events_source_attempt_idx" ON "execution_events" USING btree ("source_id","attempt_index");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_events_signer_window_idx" ON "execution_events" USING btree ("signer","chain_id","submitted_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_events_action_idx" ON "execution_events" USING btree ("logical_action_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_events_nonce_idx" ON "execution_events" USING btree ("signer","chain_id","nonce");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "incidents_key_status_idx" ON "incidents" USING btree ("key","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "incidents_detected_idx" ON "incidents" USING btree ("detected_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "incidents_signer_idx" ON "incidents" USING btree ("signer","chain_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "signer_state_pk" ON "signer_state" USING btree ("signer","chain_id");