import { contextMigration } from "./workflows/contexts";
import { takeoverMigration } from "./workflows/takeover";
import { rerunMigration } from "./workflows/rerun-migration";
import { reproductionMigration } from "./workflows/reproduction";
import { advancedWorkerMigration } from "./worker/advanced-workflows";

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
  `
  CREATE TABLE remote_usage_observations (
    job_id TEXT NOT NULL REFERENCES jobs(id),
    session_id TEXT NOT NULL,
    charged_seconds REAL NOT NULL CHECK(charged_seconds>=0),
    actual_seconds REAL CHECK(actual_seconds IS NULL OR actual_seconds>=0),
    terminal INTEGER NOT NULL CHECK(terminal IN (0,1)),
    PRIMARY KEY(job_id, session_id)
  );
  `,
  `
  ALTER TABLE runs ADD COLUMN controlled_site_id TEXT
    CHECK(controlled_site_id IN ('store','project-board'));
  `,
  `
  CREATE TABLE report_snapshots (
    run_id TEXT PRIMARY KEY REFERENCES runs(id),
    revision TEXT NOT NULL,
    report TEXT NOT NULL CHECK(json_valid(report))
  );
  CREATE TABLE browser_session_bindings (
    session_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id)
  );
  INSERT INTO browser_session_bindings(session_id,job_id)
    SELECT json_extract(session_reference,'$.sessionId'),job_id FROM launches
    WHERE session_reference IS NOT NULL;
  CREATE TABLE replay_grants (
    owner_id TEXT NOT NULL REFERENCES owners(id),
    attempt_id TEXT NOT NULL REFERENCES attempts(id),
    session_id TEXT NOT NULL REFERENCES browser_session_bindings(session_id),
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY(owner_id,attempt_id)
  );
  `,
  `
  -- finding-v2 hashes private canonical identity rather than redacted display.
  DELETE FROM report_snapshots;
  `,
  contextMigration,
  takeoverMigration,
  rerunMigration,
  reproductionMigration,
  advancedWorkerMigration,
  `
  ALTER TABLE runs ADD COLUMN public_execution_policy TEXT
    CHECK(public_execution_policy IS NULL OR public_execution_policy='native-public-v1');
  ALTER TABLE runs ADD COLUMN public_asset_policy TEXT
    CHECK(
      (public_execution_policy IS NULL AND public_asset_policy IS NULL) OR
      (public_execution_policy IS NOT NULL AND public_asset_policy IS NOT NULL AND
        public_asset_policy='public-http-readonly-v1' AND execution_mode='website' AND
        controlled_site_id IS NULL AND scenario IS NULL)
    );
  CREATE TRIGGER runs_execution_policy_immutable
    BEFORE UPDATE OF public_execution_policy,public_asset_policy,execution_mode,controlled_site_id,scenario ON runs
    WHEN NEW.public_execution_policy IS NOT OLD.public_execution_policy OR
      NEW.public_asset_policy IS NOT OLD.public_asset_policy OR
      NEW.execution_mode IS NOT OLD.execution_mode OR
      NEW.controlled_site_id IS NOT OLD.controlled_site_id OR NEW.scenario IS NOT OLD.scenario
    BEGIN SELECT RAISE(ABORT,'immutable_execution_policy'); END;
  CREATE TABLE native_resources (
    job_id TEXT PRIMARY KEY REFERENCES launches(job_id),
    extension_id TEXT UNIQUE,
    resource TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE native_resource_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES launches(job_id),
    resource TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE managed_runs (
    cursor INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    owner_id TEXT NOT NULL REFERENCES owners(id),
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    execution_policy TEXT NOT NULL CHECK(execution_policy='browserbase-managed-v1'),
    scope TEXT NOT NULL CHECK(json_valid(scope)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    cancel_requested_at INTEGER,
    UNIQUE(owner_id,idempotency_key)
  );
  CREATE INDEX managed_runs_owner ON managed_runs(owner_id,cursor);
  CREATE TABLE managed_attempts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES managed_runs(id),
    persona TEXT NOT NULL CHECK(json_valid(persona)),
    goal TEXT NOT NULL,
    criteria TEXT NOT NULL CHECK(json_valid(criteria)),
    status TEXT NOT NULL DEFAULT 'queued'
      CHECK(status IN ('queued','running','completed','failed','cancelled','cleanup_required')),
    state TEXT NOT NULL DEFAULT 'queued'
      CHECK(state IN ('queued','reserved','dispatched','quarantined','settled')),
    provider_status TEXT,
    cleanup TEXT NOT NULL DEFAULT 'not_started' CHECK(cleanup IN ('not_started','unconfirmed','closed')),
    cancel_requested_at INTEGER,
    result TEXT CHECK(result IS NULL OR json_valid(result)),
    error TEXT,
    reserved_seconds INTEGER NOT NULL DEFAULT 0 CHECK(reserved_seconds>=0),
    consumed_seconds INTEGER NOT NULL DEFAULT 0 CHECK(consumed_seconds>=0),
    released_seconds INTEGER NOT NULL DEFAULT 0 CHECK(released_seconds>=0 AND released_seconds<=reserved_seconds),
    actual_browser_seconds REAL CHECK(actual_browser_seconds IS NULL OR actual_browser_seconds>=0),
    correlation_token TEXT NOT NULL UNIQUE,
    started_at INTEGER,
    dispatch_started INTEGER NOT NULL DEFAULT 0 CHECK(dispatch_started IN (0,1)),
    provider_run_id TEXT UNIQUE,
    provider_session_id TEXT UNIQUE,
    live_view_url TEXT,
    replay_url TEXT,
    lease_owner TEXT,
    lease_generation INTEGER NOT NULL DEFAULT 0 CHECK(lease_generation>=0),
    lease_expires_at INTEGER,
    recovery_count INTEGER NOT NULL DEFAULT 0 CHECK(recovery_count>=0),
    recovery_after INTEGER
  );
  CREATE INDEX managed_attempts_run ON managed_attempts(run_id);
  CREATE INDEX managed_attempts_queue ON managed_attempts(state,lease_expires_at,recovery_after);
  CREATE TABLE managed_progress (
    attempt_id TEXT NOT NULL REFERENCES managed_attempts(id),
    provider_event_hash TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK(sequence>0 AND sequence<=500),
    timestamp TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('status','text','tool','error')),
    text TEXT NOT NULL,
    PRIMARY KEY(attempt_id,provider_event_hash),
    UNIQUE(attempt_id,sequence)
  );
  `,
  `
  ALTER TABLE managed_attempts ADD COLUMN provider_agent_id TEXT
    CHECK(provider_agent_id IS NULL OR (length(provider_agent_id) BETWEEN 1 AND 256 AND length(trim(provider_agent_id))>0));
  ALTER TABLE managed_attempts ADD COLUMN provider_task TEXT
    CHECK(provider_task IS NULL OR (length(provider_task) BETWEEN 1 AND 65536 AND length(trim(provider_task))>0))
    CHECK((provider_agent_id IS NULL AND provider_task IS NULL) OR
      (provider_agent_id IS NOT NULL AND provider_task IS NOT NULL));
  CREATE TRIGGER managed_dispatch_reference_required
    BEFORE UPDATE OF dispatch_started ON managed_attempts
    WHEN OLD.dispatch_started=0 AND NEW.dispatch_started=1 AND
      (NEW.provider_agent_id IS NULL OR NEW.provider_task IS NULL)
    BEGIN SELECT RAISE(ABORT,'managed_dispatch_reference_invalid'); END;
  CREATE TRIGGER managed_dispatch_reference_immutable
    BEFORE UPDATE OF provider_agent_id,provider_task,dispatch_started ON managed_attempts
    WHEN OLD.dispatch_started=1 AND (NEW.provider_agent_id IS NOT OLD.provider_agent_id OR
      NEW.provider_task IS NOT OLD.provider_task OR NEW.dispatch_started IS NOT OLD.dispatch_started)
    BEGIN SELECT RAISE(ABORT,'immutable_managed_dispatch'); END;
  `,
] as const;
