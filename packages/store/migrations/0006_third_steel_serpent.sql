CREATE TABLE IF NOT EXISTS "watched_signers" (
	"signer" text NOT NULL,
	"chain_id" integer NOT NULL,
	"agent_id" text NOT NULL,
	"label" text,
	"registered_at" timestamp with time zone NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "watched_signers_signer_chain_id_pk" PRIMARY KEY("signer","chain_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "watched_signers_chain_idx" ON "watched_signers" USING btree ("chain_id","active");