/**
 * Tracks repository — CRUD operations on the `tracks` table within a project DB.
 */
import { v4 as uuid } from "uuid";
import { getProjectDatabase, persistProjectDatabase } from "./connection";
import type { Track, TrackType } from "../../../src/composer/types/project";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function rowToTrack(row: unknown[]): Track {
  return {
    id: row[0] as string,
    name: row[1] as string,
    type: row[2] as TrackType,
    order: row[3] as number,
    muted: Boolean(row[4]),
    locked: Boolean(row[5]),
    visible: Boolean(row[6]),
    isComposite: Boolean(row[7]),
  };
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function listTracks(projectId: string): Track[] {
  const db = getProjectDatabase(projectId);
  if (!db) throw new Error(`Project ${projectId} is not open`);

  const result = db.exec(
    `SELECT id, name, type, "order", muted, locked, visible, is_composite
     FROM tracks ORDER BY "order" ASC`,
  );
  return (result[0]?.values ?? []).map(rowToTrack);
}

export function createTrack(
  projectId: string,
  name: string,
  type: TrackType,
): Track {
  const db = getProjectDatabase(projectId);
  if (!db) throw new Error(`Project ${projectId} is not open`);

  // Place at end
  const orderResult = db.exec(`SELECT COALESCE(MAX("order"), -1) + 1 FROM tracks`);
  const order = (orderResult[0]?.values?.[0]?.[0] ?? 0) as number;

  const id = uuid();
  db.run(
    `INSERT INTO tracks (id, name, type, "order") VALUES (?, ?, ?, ?)`,
    [id, name, type, order],
  );
  persistProjectDatabase(projectId);

  return { id, name, type, order, muted: false, locked: false, visible: true, isComposite: false };
}

export function updateTrack(
  projectId: string,
  trackId: string,
  patch: Partial<Pick<Track, "name" | "muted" | "locked" | "visible" | "order" | "isComposite">>,
): Track {
  const db = getProjectDatabase(projectId);
  if (!db) throw new Error(`Project ${projectId} is not open`);

  const fields: string[] = [];
  const values: unknown[] = [];

  if (patch.name !== undefined) { fields.push("name = ?"); values.push(patch.name); }
  if (patch.muted !== undefined) { fields.push("muted = ?"); values.push(patch.muted ? 1 : 0); }
  if (patch.locked !== undefined) { fields.push("locked = ?"); values.push(patch.locked ? 1 : 0); }
  if (patch.visible !== undefined) { fields.push("visible = ?"); values.push(patch.visible ? 1 : 0); }
  if (patch.order !== undefined) { fields.push('"order" = ?'); values.push(patch.order); }
  if (patch.isComposite !== undefined) { fields.push("is_composite = ?"); values.push(patch.isComposite ? 1 : 0); }

  if (fields.length === 0) {
    // Nothing to update — return current state
    return getTrackById(projectId, trackId);
  }

  values.push(trackId);
  db.run(`UPDATE tracks SET ${fields.join(", ")} WHERE id = ?`, values);
  persistProjectDatabase(projectId);

  return getTrackById(projectId, trackId);
}

export function deleteTrack(projectId: string, trackId: string): void {
  const db = getProjectDatabase(projectId);
  if (!db) throw new Error(`Project ${projectId} is not open`);

  db.run(`DELETE FROM tracks WHERE id = ?`, [trackId]);
  persistProjectDatabase(projectId);
}

export function getTrackById(projectId: string, trackId: string): Track {
  const db = getProjectDatabase(projectId);
  if (!db) throw new Error(`Project ${projectId} is not open`);

  const result = db.exec(
    `SELECT id, name, type, "order", muted, locked, visible, is_composite
     FROM tracks WHERE id = ? LIMIT 1`,
    [trackId],
  );
  const row = result[0]?.values?.[0];
  if (!row) throw new Error(`Track ${trackId} not found`);
  return rowToTrack(row);
}

/**
 * Creates the two default tracks (Video 1, Audio 1) for a new project.
 */
export function createDefaultTracks(projectId: string): Track[] {
  const video = createTrack(projectId, "Video 1", "video");
  const audio = createTrack(projectId, "Audio 1", "audio");
  return [video, audio];
}
