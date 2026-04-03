/**
 * Multi-project database connection manager for the Composer module.
 *
 * Unlike the Workflow module (single singleton DB), Composer manages one
 * sql.js database per open project. Databases are keyed by project ID in a Map.
 *
 * Pattern mirrors electron/workflow/db/connection.ts but adapted for the
 * multi-DB use case.
 */
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { app } from "electron";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from "fs";
import { join, dirname } from "path";
import {
  initializeSchema,
  runMigrations,
  readSchemaVersion,
  CURRENT_SCHEMA_VERSION,
} from "./schema";

export type { SqlJsDatabase };

// ─── State ────────────────────────────────────────────────────────────────────

// Keep a shared SQL.js initialisation promise to avoid loading WASM twice
let sqlJsInitPromise: Promise<Awaited<ReturnType<typeof initSqlJs>>> | null = null;

function getSqlJs() {
  if (!sqlJsInitPromise) {
    sqlJsInitPromise = initSqlJs() as Promise<Awaited<ReturnType<typeof initSqlJs>>>;
  }
  return sqlJsInitPromise;
}

interface ProjectDbEntry {
  db: SqlJsDatabase;
  dbPath: string;
  persistTimer: ReturnType<typeof setTimeout> | null;
}

const openDatabases = new Map<string, ProjectDbEntry>();

// ─── Persistence helpers ──────────────────────────────────────────────────────

function saveToDisk(entry: ProjectDbEntry): void {
  const dir = dirname(entry.dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const data = entry.db.export();
  writeFileSync(entry.dbPath, Buffer.from(data));
}

export function persistProjectDatabase(projectId: string): void {
  const entry = openDatabases.get(projectId);
  if (!entry) return;

  if (entry.persistTimer) {
    clearTimeout(entry.persistTimer);
  }
  entry.persistTimer = setTimeout(() => {
    entry.persistTimer = null;
    try {
      saveToDisk(entry);
    } catch (err) {
      console.error(
        `[Composer DB] Failed to persist project ${projectId}:`,
        err,
      );
    }
  }, 500);
}

export function persistProjectDatabaseNow(projectId: string): void {
  const entry = openDatabases.get(projectId);
  if (!entry) return;
  if (entry.persistTimer) {
    clearTimeout(entry.persistTimer);
    entry.persistTimer = null;
  }
  saveToDisk(entry);
}

// ─── Transaction helper ───────────────────────────────────────────────────────

export function transaction<T>(
  projectId: string,
  fn: (db: SqlJsDatabase) => T,
): T {
  const entry = openDatabases.get(projectId);
  if (!entry) throw new Error(`No open database for project ${projectId}`);

  entry.db.run("BEGIN");
  try {
    const result = fn(entry.db);
    entry.db.run("COMMIT");
    persistProjectDatabase(projectId);
    return result;
  } catch (err) {
    try {
      entry.db.run("ROLLBACK");
    } catch {
      /* ignore rollback errors */
    }
    throw err;
  }
}

// ─── Open / close ─────────────────────────────────────────────────────────────

/**
 * Opens (or creates) the SQLite database for a project.
 *
 * @param projectId UUID of the project
 * @param dbPath    Absolute path to the .composer file
 * @param projectName Name used when initialising a new schema
 */
export async function openProjectDatabase(
  projectId: string,
  dbPath: string,
  projectName: string,
): Promise<SqlJsDatabase> {
  const existing = openDatabases.get(projectId);
  if (existing) return existing.db;

  const SQL = await getSqlJs();
  const appVersion = app.getVersion();
  const dbExists = existsSync(dbPath);

  let db: SqlJsDatabase | null = null;
  let isCorrupt = false;

  if (dbExists) {
    try {
      const fileBuffer = readFileSync(dbPath);
      db = new SQL.Database(fileBuffer);
      const result = db.exec("PRAGMA integrity_check");
      const ok = result[0]?.values?.[0]?.[0];
      if (ok !== "ok") throw new Error("integrity_check failed");
    } catch (error) {
      console.error(
        `[Composer DB] Database corrupt or unreadable (${dbPath}):`,
        error,
      );
      isCorrupt = true;
      if (db) { db.close(); db = null; }
      const backupPath = `${dbPath}.corrupt.${Date.now()}`;
      renameSync(dbPath, backupPath);
      console.warn(`[Composer DB] Corrupt DB backed up to: ${backupPath}`);
    }
  }

  if (!db || isCorrupt) {
    db = new SQL.Database();
    initializeSchema(db, projectName, appVersion);
    saveToDisk({ db, dbPath, persistTimer: null });
    console.log(`[Composer DB] Created new database at: ${dbPath}`);
  } else {
    // Existing DB — check schema version
    const version = readSchemaVersion(db);
    if (version > CURRENT_SCHEMA_VERSION) {
      db.close();
      throw new Error(
        `Project "${projectName}" was created with a newer version of Composer (schema v${version}). ` +
          `Please update the app to open this project.`,
      );
    }
    if (version < CURRENT_SCHEMA_VERSION) {
      // Back up before migration
      const autosaveDir = join(dirname(dbPath), "autosave");
      if (!existsSync(autosaveDir)) mkdirSync(autosaveDir, { recursive: true });
      const backupPath = join(autosaveDir, `pre-migration-v${version}-${Date.now()}.composer`);
      const backup = db.export();
      writeFileSync(backupPath, Buffer.from(backup));
      console.log(`[Composer DB] Pre-migration backup saved to: ${backupPath}`);
      runMigrations(db, appVersion);
      saveToDisk({ db, dbPath, persistTimer: null });
    }
  }

  openDatabases.set(projectId, { db: db!, dbPath, persistTimer: null });
  return db!;
}

export function getProjectDatabase(projectId: string): SqlJsDatabase | null {
  return openDatabases.get(projectId)?.db ?? null;
}

export function closeProjectDatabase(projectId: string): void {
  const entry = openDatabases.get(projectId);
  if (!entry) return;

  if (entry.persistTimer) {
    clearTimeout(entry.persistTimer);
    entry.persistTimer = null;
  }

  try {
    saveToDisk(entry);
  } catch (err) {
    console.error(
      `[Composer DB] Error flushing project ${projectId} on close:`,
      err,
    );
  }

  entry.db.close();
  openDatabases.delete(projectId);
}

export function closeAllProjectDatabases(): void {
  for (const projectId of openDatabases.keys()) {
    closeProjectDatabase(projectId);
  }
}
