export const rerunMigration = `
  CREATE TABLE rerun_runs (
    child_run_id TEXT PRIMARY KEY REFERENCES runs(id),
    parent_run_id TEXT NOT NULL REFERENCES runs(id),
    context TEXT NOT NULL CHECK(context = 'fresh'),
    CHECK(child_run_id <> parent_run_id)
  );
  CREATE INDEX rerun_runs_parent ON rerun_runs(parent_run_id);
  CREATE TABLE rerun_attempts (
    child_attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),
    parent_attempt_id TEXT NOT NULL REFERENCES attempts(id),
    child_run_id TEXT NOT NULL REFERENCES rerun_runs(child_run_id),
    UNIQUE(child_run_id, parent_attempt_id),
    CHECK(child_attempt_id <> parent_attempt_id)
  );
`;
