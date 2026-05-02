/**
 * Composer SQLite schema — tables, migrations, and initialisation.
 * Each .composer project file has its own schema instance.
 * Pattern mirrors electron/workflow/db/schema.ts.
 */
import type { Database as SqlJsDatabase } from "sql.js";

export const CURRENT_SCHEMA_VERSION = 7;

// ─── Migration definition ─────────────────────────────────────────────────────

interface NamedMigration {
  id: string; // e.g. "001_initial"
  apply: (db: SqlJsDatabase) => void;
}

// ─── Named migrations list ────────────────────────────────────────────────────

const MIGRATIONS: NamedMigration[] = [
  {
    id: "001_initial",
    apply: (db) => {
      // meta singleton
      db.run(`
        CREATE TABLE IF NOT EXISTS meta (
          schema_version INTEGER NOT NULL,
          app_version    TEXT    NOT NULL,
          project_name   TEXT    NOT NULL,
          duration       REAL    NOT NULL DEFAULT 60,
          fps            INTEGER NOT NULL DEFAULT 30,
          created_at     TEXT    NOT NULL,
          updated_at     TEXT    NOT NULL
        )
      `);

      // tracks
      db.run(`
        CREATE TABLE IF NOT EXISTS tracks (
          id           TEXT    PRIMARY KEY,
          name         TEXT    NOT NULL,
          type         TEXT    NOT NULL CHECK (type IN ('video', 'audio')),
          "order"      INTEGER NOT NULL,
          muted        INTEGER NOT NULL DEFAULT 0,
          locked       INTEGER NOT NULL DEFAULT 0,
          visible      INTEGER NOT NULL DEFAULT 1,
          is_composite INTEGER NOT NULL DEFAULT 0
        )
      `);

      // clips
      db.run(`
        CREATE TABLE IF NOT EXISTS clips (
          id              TEXT  PRIMARY KEY,
          track_id        TEXT  NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
          source_type     TEXT  NOT NULL CHECK (source_type IN ('asset', 'import', 'ai-result', 'workflow-ref')),
          source_path     TEXT,
          source_asset_id TEXT,
          start_time      REAL  NOT NULL,
          duration        REAL  NOT NULL,
          trim_start      REAL  NOT NULL DEFAULT 0,
          trim_end        REAL,
          speed           REAL  NOT NULL DEFAULT 1.0,
          created_at      TEXT  NOT NULL
        )
      `);

      // regions (L3 — created now but only used from Phase 3)
      db.run(`
        CREATE TABLE IF NOT EXISTS regions (
          id           TEXT PRIMARY KEY,
          track_id     TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
          start_time   REAL NOT NULL,
          end_time     REAL NOT NULL,
          workflow_id  TEXT,
          execution_id TEXT,
          result_path  TEXT,
          status       TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'success', 'error', 'stale')),
          created_at   TEXT NOT NULL,
          updated_at   TEXT NOT NULL
        )
      `);

      // region_clips junction
      db.run(`
        CREATE TABLE IF NOT EXISTS region_clips (
          id              TEXT PRIMARY KEY,
          region_id       TEXT NOT NULL REFERENCES regions(id)  ON DELETE CASCADE,
          clip_id         TEXT NOT NULL REFERENCES clips(id)    ON DELETE CASCADE,
          clip_start_time REAL NOT NULL,
          clip_end_time   REAL NOT NULL
        )
      `);

      // schema_migrations tracking
      db.run(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id         TEXT PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);

      // Indexes
      db.run(
        `CREATE INDEX IF NOT EXISTS idx_clips_track ON clips(track_id)`,
      );
      db.run(
        `CREATE INDEX IF NOT EXISTS idx_regions_track ON regions(track_id)`,
      );
      db.run(
        `CREATE INDEX IF NOT EXISTS idx_region_clips_region ON region_clips(region_id)`,
      );
    },
  },
  {
    id: "002_ui_layout",
    apply: (db) => {
      // Add layout columns to meta if they don't exist yet (idempotent)
      const info = db.exec(`PRAGMA table_info(meta)`);
      const columns = (info[0]?.values ?? []).map((r) => r[1] as string);
      if (!columns.includes("layout_preset")) {
        db.run(`ALTER TABLE meta ADD COLUMN layout_preset TEXT NOT NULL DEFAULT 'timeline'`);
      }
      if (!columns.includes("layout_sizes")) {
        db.run(`ALTER TABLE meta ADD COLUMN layout_sizes TEXT NOT NULL DEFAULT '{}'`);
      }
    },
  },
  {
    id: "003_project_output",
    apply: (db) => {
      const info = db.exec(`PRAGMA table_info(meta)`);
      const columns = (info[0]?.values ?? []).map((row) => row[1] as string);
      if (!columns.includes("width")) {
        db.run(`ALTER TABLE meta ADD COLUMN width INTEGER NOT NULL DEFAULT 1920`);
      }
      if (!columns.includes("height")) {
        db.run(`ALTER TABLE meta ADD COLUMN height INTEGER NOT NULL DEFAULT 1080`);
      }
      if (!columns.includes("safe_zone_enabled")) {
        db.run(`ALTER TABLE meta ADD COLUMN safe_zone_enabled INTEGER NOT NULL DEFAULT 1`);
      }
      if (!columns.includes("safe_zone_margin")) {
        db.run(`ALTER TABLE meta ADD COLUMN safe_zone_margin REAL NOT NULL DEFAULT 0.1`);
      }
    },
  },
  {
    id: "004_clip_transform",
    apply: (db) => {
      const info = db.exec(`PRAGMA table_info(clips)`);
      const columns = (info[0]?.values ?? []).map((row) => row[1] as string);
      if (!columns.includes("transform_offset_x")) {
        db.run(`ALTER TABLE clips ADD COLUMN transform_offset_x REAL NOT NULL DEFAULT 0`);
      }
      if (!columns.includes("transform_offset_y")) {
        db.run(`ALTER TABLE clips ADD COLUMN transform_offset_y REAL NOT NULL DEFAULT 0`);
      }
      if (!columns.includes("transform_scale")) {
        db.run(`ALTER TABLE clips ADD COLUMN transform_scale REAL NOT NULL DEFAULT 1`);
      }
    },
  },
  {
    id: "005_project_playback_quality",
    apply: (db) => {
      const info = db.exec(`PRAGMA table_info(meta)`);
      const columns = (info[0]?.values ?? []).map((row) => row[1] as string);
      if (!columns.includes("playback_quality")) {
        db.run(
          `ALTER TABLE meta ADD COLUMN playback_quality TEXT NOT NULL DEFAULT 'med'`,
        );
      }
    },
  },
  {
    id: "006_sequence_preview",
    apply: (db) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS sequence_preview (
          id                   INTEGER PRIMARY KEY CHECK (id = 1),
          status               TEXT    NOT NULL DEFAULT 'missing'
                                     CHECK (status IN ('missing', 'processing', 'ready', 'stale', 'error')),
          request_signature    TEXT    NOT NULL DEFAULT '',
          request_json         TEXT    NOT NULL DEFAULT '{}',
          file_path            TEXT,
          playback_quality     TEXT    NOT NULL DEFAULT 'med',
          invalidation_reasons TEXT    NOT NULL DEFAULT '[]',
          error_message        TEXT,
          created_at           TEXT    NOT NULL,
          updated_at           TEXT    NOT NULL,
          last_requested_at    TEXT,
          started_at           TEXT,
          completed_at         TEXT,
          invalidated_at       TEXT
        )
      `);

      const now = new Date().toISOString();
      db.run(
        `INSERT OR IGNORE INTO sequence_preview (
           id,
           status,
           request_signature,
           request_json,
           file_path,
           playback_quality,
           invalidation_reasons,
           created_at,
           updated_at
         )
         VALUES (1, 'missing', '', '{}', NULL, 'med', '[]', ?, ?)`,
        [now, now],
      );
    },
  },
  {
    id: "007_clip_style",
    apply: (db) => {
      const info = db.exec(`PRAGMA table_info(clips)`);
      const columns = (info[0]?.values ?? []).map((row) => row[1] as string);
      if (!columns.includes("rotation_z")) {
        db.run(`ALTER TABLE clips ADD COLUMN rotation_z REAL NOT NULL DEFAULT 0`);
      }
      if (!columns.includes("opacity")) {
        db.run(`ALTER TABLE clips ADD COLUMN opacity REAL NOT NULL DEFAULT 1`);
      }
      if (!columns.includes("fade_in_duration")) {
        db.run(
          `ALTER TABLE clips ADD COLUMN fade_in_duration REAL NOT NULL DEFAULT 0`,
        );
      }
      if (!columns.includes("fade_out_duration")) {
        db.run(
          `ALTER TABLE clips ADD COLUMN fade_out_duration REAL NOT NULL DEFAULT 0`,
        );
      }
    },
  },
];

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialise schema on a fresh DB.
 * Creates all tables, marks all migrations as applied, and inserts the meta row.
 */
export function initializeSchema(
  db: SqlJsDatabase,
  projectName: string,
  appVersion: string,
): void {
  const now = new Date().toISOString();

  for (const migration of MIGRATIONS) {
    migration.apply(db);
  }

  // Insert meta singleton
  db.run(
     `INSERT INTO meta (
        schema_version, app_version, project_name, duration, fps, width, height,
        playback_quality, safe_zone_enabled, safe_zone_margin, layout_preset,
        layout_sizes, created_at, updated_at
      )
      VALUES (?, ?, ?, 60, 30, 1920, 1080, 'med', 1, 0.1, 'timeline', '{}', ?, ?)`,
     [CURRENT_SCHEMA_VERSION, appVersion, projectName, now, now],
   );

  db.run(
    `INSERT OR IGNORE INTO sequence_preview (
       id,
       status,
       request_signature,
       request_json,
       file_path,
       playback_quality,
       invalidation_reasons,
       created_at,
       updated_at
     )
     VALUES (1, 'missing', '', '{}', NULL, 'med', '[]', ?, ?)`,
    [now, now],
  );

  // Mark all migrations as applied
  for (const migration of MIGRATIONS) {
    db.run(
      `INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)`,
      [migration.id],
    );
  }
}

/**
 * Run any migrations not yet applied to an existing DB.
 * Called on every project open after schema_version check.
 */
export function runMigrations(
  db: SqlJsDatabase,
  appVersion: string,
): void {
  // Collect applied migration IDs
  let applied: Set<string>;
  try {
    const rows = db.exec(
      `SELECT id FROM schema_migrations`,
    );
    applied = new Set(
      (rows[0]?.values ?? []).map((row) => row[0] as string),
    );
  } catch {
    // schema_migrations table might not exist yet in legacy DBs
    applied = new Set();
  }

  // Apply missing migrations in order
  let didRun = false;
  for (const migration of MIGRATIONS) {
    if (!applied.has(migration.id)) {
      console.log(`[Composer DB] Applying migration: ${migration.id}`);
      migration.apply(db);
      db.run(
        `INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)`,
        [migration.id],
      );
      didRun = true;
    }
  }

  if (didRun) {
    const now = new Date().toISOString();
    db.run(
      `UPDATE meta SET schema_version = ?, app_version = ?, updated_at = ?`,
      [CURRENT_SCHEMA_VERSION, appVersion, now],
    );
  }
}

/**
 * Read schema version from an open DB. Returns 0 if meta table is absent.
 */
export function readSchemaVersion(db: SqlJsDatabase): number {
  try {
    const rows = db.exec(`SELECT schema_version FROM meta LIMIT 1`);
    const val = rows[0]?.values?.[0]?.[0];
    return typeof val === "number" ? val : 0;
  } catch {
    return 0;
  }
}
