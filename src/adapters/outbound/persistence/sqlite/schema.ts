/**
 * SQLite schema definitions for the Agent Secretary storage layer.
 *
 * Every domain object from DEC-004 maps to a table. Complex/nested fields
 * (arrays, objects) are stored as JSON text columns and (de)serialized at the
 * repository boundary. Scalar columns are indexed for the common access
 * patterns described in the issue (by task, by session, by attention state,
 * by timestamp).
 *
 * The `events` table is the immutable append-only event journal (DEC-012).
 * SQLite `AFTER` triggers reject any UPDATE or DELETE on event rows so that
 * the journal can only grow forward.
 *
 * Context Capsules (DEC-020) are stored as scoped rows in `context_capsules`
 * with a `scope` discriminator (`project` | `task` | `session`) and a
 * `owner_id` referencing the owning entity. This gives strict isolation: a
 * query for one scope never touches another scope's rows.
 */

/* ------------------------------------------------------------------ *
 * Table: projects
 * ------------------------------------------------------------------ */
export const CREATE_TABLE_PROJECTS = /* sql */ `
CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY NOT NULL,
  name         TEXT NOT NULL,
  repo         TEXT NOT NULL,        -- JSON: RepoMetadata
  policies     TEXT NOT NULL,        -- JSON: ProjectPolicies
  capsule_id   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
`;

/* ------------------------------------------------------------------ *
 * Table: tasks
 * ------------------------------------------------------------------ */
export const CREATE_TABLE_TASKS = /* sql */ `
CREATE TABLE IF NOT EXISTS tasks (
  id                 TEXT PRIMARY KEY NOT NULL,
  project_id         TEXT NOT NULL,
  objective          TEXT NOT NULL,
  state              TEXT NOT NULL,
  agent_ids          TEXT NOT NULL DEFAULT '[]',    -- JSON: EntityId[]
  session_ids        TEXT NOT NULL DEFAULT '[]',    -- JSON: EntityId[]
  deliverable_ids    TEXT NOT NULL DEFAULT '[]',    -- JSON: EntityId[]
  attention_item_ids TEXT NOT NULL DEFAULT '[]',    -- JSON: EntityId[]
  capsule_id         TEXT NOT NULL,
  worktree_path      TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);
`;

/* ------------------------------------------------------------------ *
 * Table: agents
 * ------------------------------------------------------------------ */
export const CREATE_TABLE_AGENTS = /* sql */ `
CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY NOT NULL,
  name          TEXT NOT NULL,
  provider      TEXT NOT NULL,
  fidelity_tier TEXT NOT NULL,
  runtime       TEXT NOT NULL,        -- JSON: AgentRuntime
  created_at    TEXT NOT NULL
);
`;

/* ------------------------------------------------------------------ *
 * Table: sessions
 * ------------------------------------------------------------------ */
export const CREATE_TABLE_SESSIONS = /* sql */ `
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY NOT NULL,
  task_id         TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  status          TEXT NOT NULL,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  event_ids       TEXT NOT NULL DEFAULT '[]',    -- JSON: EntityId[]
  deliverable_ids TEXT NOT NULL DEFAULT '[]',    -- JSON: EntityId[]
  capsule_id      TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);
`;

/* ------------------------------------------------------------------ *
 * Table: deliverables
 * ------------------------------------------------------------------ */
export const CREATE_TABLE_DELIVERABLES = /* sql */ `
CREATE TABLE IF NOT EXISTS deliverables (
  id          TEXT PRIMARY KEY NOT NULL,
  task_id     TEXT NOT NULL,
  session_id  TEXT,
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  artifacts   TEXT NOT NULL DEFAULT '{}',  -- JSON: DeliverableArtifacts
  created_at  TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
`;

/* ------------------------------------------------------------------ *
 * Table: events — the immutable append-only event journal (DEC-012)
 * ------------------------------------------------------------------ */
export const CREATE_TABLE_EVENTS = /* sql */ `
CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY NOT NULL,
  session_id  TEXT NOT NULL,
  task_id     TEXT NOT NULL,
  timestamp   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  payload     TEXT NOT NULL DEFAULT '{}',  -- JSON: Record<string, unknown>
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);
`;

/**
 * Triggers that enforce append-only semantics on the `events` table.
 * Any attempt to UPDATE or DELETE an existing event row is rejected with an
 * error, so the journal can only grow forward (DEC-012).
 */
export const CREATE_EVENT_NO_UPDATE_TRIGGER = /* sql */ `
CREATE TRIGGER IF NOT EXISTS events_no_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events table is append-only: UPDATE is not allowed');
END;
`;

export const CREATE_EVENT_NO_DELETE_TRIGGER = /* sql */ `
CREATE TRIGGER IF NOT EXISTS events_no_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events table is append-only: DELETE is not allowed');
END;
`;

/* ------------------------------------------------------------------ *
 * Table: attention_items
 * ------------------------------------------------------------------ */
export const CREATE_TABLE_ATTENTION_ITEMS = /* sql */ `
CREATE TABLE IF NOT EXISTS attention_items (
  id                     TEXT PRIMARY KEY NOT NULL,
  task_id                TEXT NOT NULL,
  category               TEXT NOT NULL,
  priority               TEXT NOT NULL,
  reason                 TEXT NOT NULL,
  decision_requested     TEXT NOT NULL,
  affected_capability    TEXT,
  suggested_safe_options TEXT NOT NULL DEFAULT '[]',  -- JSON: string[]
  deadline               TEXT,
  blocking_impact        INTEGER NOT NULL DEFAULT 0,  -- boolean as 0/1
  related_event_ids      TEXT NOT NULL DEFAULT '[]',  -- JSON: EntityId[]
  resolved               INTEGER NOT NULL DEFAULT 0,  -- boolean as 0/1
  created_at             TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);
`;

/* ------------------------------------------------------------------ *
 * Table: decisions
 * ------------------------------------------------------------------ */
export const CREATE_TABLE_DECISIONS = /* sql */ `
CREATE TABLE IF NOT EXISTS decisions (
  id                TEXT PRIMARY KEY NOT NULL,
  task_id           TEXT NOT NULL,
  attention_item_id TEXT,
  question          TEXT NOT NULL,
  options           TEXT NOT NULL DEFAULT '[]',  -- JSON: string[]
  answer            TEXT,
  status            TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  decided_at        TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (attention_item_id) REFERENCES attention_items(id)
);
`;

/* ------------------------------------------------------------------ *
 * Table: approvals
 * ------------------------------------------------------------------ */
export const CREATE_TABLE_APPROVALS = /* sql */ `
CREATE TABLE IF NOT EXISTS approvals (
  id                TEXT PRIMARY KEY NOT NULL,
  task_id           TEXT NOT NULL,
  attention_item_id TEXT,
  capability        TEXT NOT NULL,
  destination       TEXT,
  scope             TEXT NOT NULL,
  authority_level   TEXT NOT NULL,
  granted           INTEGER NOT NULL DEFAULT 0,  -- boolean as 0/1
  granted_at        TEXT,
  expires_at        TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (attention_item_id) REFERENCES attention_items(id)
);
`;

/* ------------------------------------------------------------------ *
 * Table: context_capsules (DEC-020)
 *
 * Scoped rows: each Project, Task, and Session owns a capsule row. The
 * `scope` column discriminates the content shape; `owner_id` references the
 * owning entity. Queries filter by scope + owner_id so one scope's rows are
 * never mixed with another's (strict isolation, DEC-003).
 * ------------------------------------------------------------------ */
export const CREATE_TABLE_CONTEXT_CAPSULES = /* sql */ `
CREATE TABLE IF NOT EXISTS context_capsules (
  id          TEXT PRIMARY KEY NOT NULL,
  scope       TEXT NOT NULL,          -- 'project' | 'task' | 'session'
  owner_id    TEXT NOT NULL,
  content     TEXT NOT NULL,          -- JSON: scope-specific content
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
`;

/* ------------------------------------------------------------------ *
 * Indexes for common access patterns
 * ------------------------------------------------------------------ */

/** Tasks by project (list tasks belonging to a project). */
export const CREATE_INDEX_TASKS_BY_PROJECT = /* sql */ `
CREATE INDEX IF NOT EXISTS idx_tasks_project_id
ON tasks(project_id);
`;

/** Sessions by task (list runs for a task). */
export const CREATE_INDEX_SESSIONS_BY_TASK = /* sql */ `
CREATE INDEX IF NOT EXISTS idx_sessions_task_id
ON sessions(task_id);
`;

/** Sessions by agent (list runs executed by an agent). */
export const CREATE_INDEX_SESSIONS_BY_AGENT = /* sql */ `
CREATE INDEX IF NOT EXISTS idx_sessions_agent_id
ON sessions(agent_id);
`;

/** Deliverables by task. */
export const CREATE_INDEX_DELIVERABLES_BY_TASK = /* sql */ `
CREATE INDEX IF NOT EXISTS idx_deliverables_task_id
ON deliverables(task_id);
`;

/** Deliverables by session. */
export const CREATE_INDEX_DELIVERABLES_BY_SESSION = /* sql */ `
CREATE INDEX IF NOT EXISTS idx_deliverables_session_id
ON deliverables(session_id);
`;

/** Events by task (retrieve the event stream for a task). */
export const CREATE_INDEX_EVENTS_BY_TASK = /* sql */ `
CREATE INDEX IF NOT EXISTS idx_events_task_id
ON events(task_id);
`;

/** Events by session (retrieve the event stream for a session). */
export const CREATE_INDEX_EVENTS_BY_SESSION = /* sql */ `
CREATE INDEX IF NOT EXISTS idx_events_session_id
ON events(session_id);
`;

/** Events by timestamp (chronological ordering / time-range queries). */
export const CREATE_INDEX_EVENTS_BY_TIMESTAMP = /* sql */ `
CREATE INDEX IF NOT EXISTS idx_events_timestamp
ON events(timestamp);
`;

/** Attention items by task. */
export const CREATE_INDEX_ATTENTION_BY_TASK = /* sql */ `
CREATE INDEX IF NOT EXISTS idx_attention_items_task_id
ON attention_items(task_id);
`;

/** Attention items by resolved state (find open items quickly). */
export const CREATE_INDEX_ATTENTION_BY_RESOLVED = /* sql */ `
CREATE INDEX IF NOT EXISTS idx_attention_items_resolved
ON attention_items(resolved);
`;

/** Attention items by priority. */
export const CREATE_INDEX_ATTENTION_BY_PRIORITY = /* sql */ `
CREATE INDEX IF NOT EXISTS idx_attention_items_priority
ON attention_items(priority);
`;

/** Decisions by task. */
export const CREATE_INDEX_DECISIONS_BY_TASK = /* sql */ `
CREATE INDEX IF NOT EXISTS idx_decisions_task_id
ON decisions(task_id);
`;

/** Decisions by status (find open decisions quickly). */
export const CREATE_INDEX_DECISIONS_BY_STATUS = /* sql */ `
CREATE INDEX IF NOT EXISTS idx_decisions_status
ON decisions(status);
`;

/** Approvals by task. */
export const CREATE_INDEX_APPROVALS_BY_TASK = /* sql */ `
CREATE INDEX IF NOT EXISTS idx_approvals_task_id
ON approvals(task_id);
`;

/** Context capsules by scope + owner (load a capsule for a specific scope). */
export const CREATE_INDEX_CAPSULES_BY_SCOPE_OWNER = /* sql */ `
CREATE UNIQUE INDEX IF NOT EXISTS idx_context_capsules_scope_owner
ON context_capsules(scope, owner_id);
`;

/**
 * Ordered list of all schema statements executed by the initial migration.
 * Tables are created first, then indexes, then the append-only triggers last
 * (so the triggers exist on an already-well-formed table).
 */
export const SCHEMA_STATEMENTS: readonly string[] = [
  CREATE_TABLE_PROJECTS,
  CREATE_TABLE_TASKS,
  CREATE_TABLE_AGENTS,
  CREATE_TABLE_SESSIONS,
  CREATE_TABLE_DELIVERABLES,
  CREATE_TABLE_EVENTS,
  CREATE_TABLE_ATTENTION_ITEMS,
  CREATE_TABLE_DECISIONS,
  CREATE_TABLE_APPROVALS,
  CREATE_TABLE_CONTEXT_CAPSULES,
  // Indexes
  CREATE_INDEX_TASKS_BY_PROJECT,
  CREATE_INDEX_SESSIONS_BY_TASK,
  CREATE_INDEX_SESSIONS_BY_AGENT,
  CREATE_INDEX_DELIVERABLES_BY_TASK,
  CREATE_INDEX_DELIVERABLES_BY_SESSION,
  CREATE_INDEX_EVENTS_BY_TASK,
  CREATE_INDEX_EVENTS_BY_SESSION,
  CREATE_INDEX_EVENTS_BY_TIMESTAMP,
  CREATE_INDEX_ATTENTION_BY_TASK,
  CREATE_INDEX_ATTENTION_BY_RESOLVED,
  CREATE_INDEX_ATTENTION_BY_PRIORITY,
  CREATE_INDEX_DECISIONS_BY_TASK,
  CREATE_INDEX_DECISIONS_BY_STATUS,
  CREATE_INDEX_APPROVALS_BY_TASK,
  CREATE_INDEX_CAPSULES_BY_SCOPE_OWNER,
  // Append-only enforcement (DEC-012) — created last
  CREATE_EVENT_NO_UPDATE_TRIGGER,
  CREATE_EVENT_NO_DELETE_TRIGGER,
];
