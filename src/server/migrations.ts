export const migrations = [
  `
  CREATE TABLE owners (
    id TEXT PRIMARY KEY,
    session_hash TEXT NOT NULL UNIQUE,
    csrf TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE rate_limits (
    bucket TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL CHECK(count >= 0)
  );
  CREATE TABLE personas (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES owners(id),
    profile TEXT NOT NULL CHECK(json_valid(profile))
  );
  CREATE INDEX personas_owner ON personas(owner_id);
  CREATE TABLE runs (
    cursor INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    owner_id TEXT NOT NULL REFERENCES owners(id),
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','gave_up','cancelled','blocked','limit_reached','infrastructure_failed','target_failed')),
    scope TEXT NOT NULL CHECK(json_valid(scope)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    cancel_requested_at TEXT,
    next_sequence INTEGER NOT NULL DEFAULT 1,
    UNIQUE(owner_id, idempotency_key)
  );
  CREATE INDEX runs_owner_cursor ON runs(owner_id, cursor);
  CREATE TABLE attempts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','gave_up','cancelled','blocked','limit_reached','infrastructure_failed','target_failed')),
    snapshot TEXT NOT NULL CHECK(json_valid(snapshot))
  );
  CREATE INDEX attempts_run ON attempts(run_id);
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id),
    status TEXT NOT NULL CHECK(status IN ('queued','leased','completed','cancelled')),
    lease_owner TEXT,
    lease_expires_at TEXT,
    lease_generation INTEGER NOT NULL DEFAULT 0 CHECK(lease_generation >= 0),
    cancel_requested_at TEXT
  );
  CREATE INDEX jobs_queue ON jobs(status, lease_expires_at);
  CREATE TABLE usage_reservations (
    job_id TEXT PRIMARY KEY REFERENCES jobs(id),
    reserved_seconds INTEGER NOT NULL DEFAULT 0 CHECK(reserved_seconds >= 0),
    consumed_seconds INTEGER NOT NULL DEFAULT 0 CHECK(consumed_seconds >= 0),
    released_seconds INTEGER NOT NULL DEFAULT 0 CHECK(released_seconds >= 0),
    CHECK(released_seconds <= reserved_seconds)
  );
  CREATE TABLE events (
    run_id TEXT NOT NULL REFERENCES runs(id),
    sequence INTEGER NOT NULL CHECK(sequence > 0),
    event TEXT NOT NULL CHECK(json_valid(event)),
    PRIMARY KEY(run_id, sequence)
  );
  CREATE TABLE evidence (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    attempt_id TEXT NOT NULL REFERENCES attempts(id),
    storage_key TEXT NOT NULL UNIQUE,
    metadata TEXT NOT NULL CHECK(json_valid(metadata))
  );
  CREATE INDEX evidence_run ON evidence(run_id);
  CREATE TABLE findings (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    attempt_id TEXT NOT NULL REFERENCES attempts(id),
    finding TEXT NOT NULL CHECK(json_valid(finding))
  );
  CREATE TABLE finding_evidence (
    finding_id TEXT NOT NULL REFERENCES findings(id),
    evidence_id TEXT NOT NULL REFERENCES evidence(id),
    PRIMARY KEY(finding_id, evidence_id)
  );
  `,
  `
  ALTER TABLE runs ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'website'
    CHECK(execution_mode IN ('website','controlled-fixture'));
  ALTER TABLE runs ADD COLUMN scenario TEXT CHECK(scenario IN ('fixed','second-coupon'));
  CREATE TABLE worker_policy (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    configuration TEXT NOT NULL CHECK(json_valid(configuration)),
    baseline_seconds INTEGER NOT NULL CHECK(baseline_seconds>=363)
  );
  CREATE TABLE launches (
    job_id TEXT PRIMARY KEY REFERENCES jobs(id),
    correlation_token TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK(state IN ('intent','active','recovering','quarantined','settled')),
    created_at TEXT NOT NULL,
    session_reference TEXT CHECK(session_reference IS NULL OR json_valid(session_reference)),
    recovery_count INTEGER NOT NULL DEFAULT 0,
    recovery_after TEXT,
    summary TEXT CHECK(summary IS NULL OR json_valid(summary)),
    usage TEXT CHECK(usage IS NULL OR json_valid(usage))
  );
  CREATE INDEX launches_recovery ON launches(state, recovery_after);
  CREATE TABLE attempt_steps (
    attempt_id TEXT NOT NULL REFERENCES attempts(id),
    ordinal INTEGER NOT NULL,
    kind TEXT NOT NULL,
    evidence_id TEXT NOT NULL REFERENCES evidence(id),
    PRIMARY KEY(attempt_id, ordinal)
  );
  `,
] as const;
