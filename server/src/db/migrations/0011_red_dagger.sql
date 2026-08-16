CREATE TABLE "convention_scan_state" (
	"repo_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"sample_files" integer DEFAULT 0 NOT NULL,
	"selected_files" integer DEFAULT 0 NOT NULL,
	"candidates_found" integer DEFAULT 0 NOT NULL,
	"new_candidates" integer DEFAULT 0 NOT NULL,
	"provider" text,
	"model" text,
	"job_id" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_skills" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "conventions" ADD COLUMN "source_rule" text NOT NULL;--> statement-breakpoint
ALTER TABLE "conventions" ADD COLUMN "status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "conventions" ADD COLUMN "edited" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conventions" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conventions" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "conventions" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "convention_scan_state" ADD CONSTRAINT "convention_scan_state_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "convention_scan_state" ADD CONSTRAINT "convention_scan_state_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conventions_source_rule_uq" ON "conventions" USING btree ("workspace_id","repo_id","source_rule");--> statement-breakpoint
CREATE INDEX "conventions_repo_idx" ON "conventions" USING btree ("repo_id");