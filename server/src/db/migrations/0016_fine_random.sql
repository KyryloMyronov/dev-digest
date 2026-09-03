CREATE TABLE "pr_file_summaries" (
	"pr_id" uuid NOT NULL,
	"path" text NOT NULL,
	"head_sha" text NOT NULL,
	"summary" text NOT NULL,
	"provider" text,
	"model" text,
	"tokens_in" integer,
	"tokens_out" integer,
	"cost_usd" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pr_file_summaries_pr_id_path_head_sha_pk" PRIMARY KEY("pr_id","path","head_sha")
);
--> statement-breakpoint
ALTER TABLE "pr_file_summaries" ADD CONSTRAINT "pr_file_summaries_pr_id_pull_requests_id_fk" FOREIGN KEY ("pr_id") REFERENCES "public"."pull_requests"("id") ON DELETE cascade ON UPDATE no action;