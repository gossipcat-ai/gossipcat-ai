-- Team Sync Schema Additions
-- Run via Supabase dashboard SQL editor
-- See: docs/superpowers/specs/2026-03-23-team-sync-design.md

-- Team config table
CREATE TABLE IF NOT EXISTS team_config (
  project_id text PRIMARY KEY,
  team_salt text NOT NULL,
  project_name text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE team_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access (single-tenant)" ON team_config
  FOR ALL USING (true) WITH CHECK (true);

-- Tasks: add display_name and token columns
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS input_tokens integer;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS output_tokens integer;

-- Agent scores: add project_id and display_name for team queries
ALTER TABLE agent_scores ADD COLUMN IF NOT EXISTS project_id text;
ALTER TABLE agent_scores ADD COLUMN IF NOT EXISTS display_name text;
CREATE INDEX IF NOT EXISTS idx_scores_project ON agent_scores(project_id);

-- Project-scoped task index for team queries
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
