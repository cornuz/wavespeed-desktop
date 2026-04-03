/**
 * Clips repository — CRUD operations on the `clips` table within a project DB.
 */
import { v4 as uuid } from "uuid";
import { getProjectDatabase, persistProjectDatabase } from "./connection";
import type { Clip, SourceType } from "../../../src/composer/types/project";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function rowToClip(row: unknown[]): Clip {
  return {
    id: row[0] as string,
    trackId: row[1] as string,
    sourceType: row[2] as SourceType,
    sourcePath: (row[3] as string | null) ?? null,
    sourceAssetId: (row[4] as string | null) ?? null,
    startTime: row[5] as number,
    duration: row[6] as number,
    trimStart: row[7] as number,
    trimEnd: (row[8] as number | null) ?? null,
    speed: row[9] as number,
    createdAt: row[10] as string,
  };
}

const SELECT_COLUMNS = `
  id, track_id, source_type, source_path, source_asset_id,
  start_time, duration, trim_start, trim_end, speed, created_at
`;

// ─── Queries ──────────────────────────────────────────────────────────────────

export function listClips(projectId: string): Clip[] {
  const db = getProjectDatabase(projectId);
  if (!db) throw new Error(`Project ${projectId} is not open`);

  const result = db.exec(
    `SELECT ${SELECT_COLUMNS} FROM clips ORDER BY start_time ASC`,
  );
  return (result[0]?.values ?? []).map(rowToClip);
}

export function listClipsByTrack(projectId: string, trackId: string): Clip[] {
  const db = getProjectDatabase(projectId);
  if (!db) throw new Error(`Project ${projectId} is not open`);

  const result = db.exec(
    `SELECT ${SELECT_COLUMNS} FROM clips WHERE track_id = ? ORDER BY start_time ASC`,
    [trackId],
  );
  return (result[0]?.values ?? []).map(rowToClip);
}

export function createClip(
  projectId: string,
  input: {
    trackId: string;
    sourceType: SourceType;
    sourcePath: string | null;
    sourceAssetId: string | null;
    startTime: number;
    duration: number;
    trimStart?: number;
    trimEnd?: number | null;
    speed?: number;
  },
): Clip {
  const db = getProjectDatabase(projectId);
  if (!db) throw new Error(`Project ${projectId} is not open`);

  const id = uuid();
  const now = new Date().toISOString();
  const trimStart = input.trimStart ?? 0;
  const trimEnd = input.trimEnd ?? null;
  const speed = input.speed ?? 1.0;

  db.run(
    `INSERT INTO clips
       (id, track_id, source_type, source_path, source_asset_id,
        start_time, duration, trim_start, trim_end, speed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.trackId,
      input.sourceType,
      input.sourcePath,
      input.sourceAssetId,
      input.startTime,
      input.duration,
      trimStart,
      trimEnd,
      speed,
      now,
    ],
  );
  persistProjectDatabase(projectId);

  return {
    id,
    trackId: input.trackId,
    sourceType: input.sourceType,
    sourcePath: input.sourcePath,
    sourceAssetId: input.sourceAssetId,
    startTime: input.startTime,
    duration: input.duration,
    trimStart,
    trimEnd,
    speed,
    createdAt: now,
  };
}

export function updateClip(
  projectId: string,
  clipId: string,
  patch: Partial<
    Pick<Clip, "startTime" | "duration" | "trimStart" | "trimEnd" | "speed" | "trackId">
  >,
): Clip {
  const db = getProjectDatabase(projectId);
  if (!db) throw new Error(`Project ${projectId} is not open`);

  const fields: string[] = [];
  const values: unknown[] = [];

  if (patch.startTime !== undefined) { fields.push("start_time = ?"); values.push(patch.startTime); }
  if (patch.duration !== undefined) { fields.push("duration = ?"); values.push(patch.duration); }
  if (patch.trimStart !== undefined) { fields.push("trim_start = ?"); values.push(patch.trimStart); }
  if ("trimEnd" in patch) { fields.push("trim_end = ?"); values.push(patch.trimEnd ?? null); }
  if (patch.speed !== undefined) { fields.push("speed = ?"); values.push(patch.speed); }
  if (patch.trackId !== undefined) { fields.push("track_id = ?"); values.push(patch.trackId); }

  if (fields.length > 0) {
    values.push(clipId);
    db.run(`UPDATE clips SET ${fields.join(", ")} WHERE id = ?`, values);
    persistProjectDatabase(projectId);
  }

  return getClipById(projectId, clipId);
}

export function deleteClip(projectId: string, clipId: string): void {
  const db = getProjectDatabase(projectId);
  if (!db) throw new Error(`Project ${projectId} is not open`);

  db.run(`DELETE FROM clips WHERE id = ?`, [clipId]);
  persistProjectDatabase(projectId);
}

export function getClipById(projectId: string, clipId: string): Clip {
  const db = getProjectDatabase(projectId);
  if (!db) throw new Error(`Project ${projectId} is not open`);

  const result = db.exec(
    `SELECT ${SELECT_COLUMNS} FROM clips WHERE id = ? LIMIT 1`,
    [clipId],
  );
  const row = result[0]?.values?.[0];
  if (!row) throw new Error(`Clip ${clipId} not found`);
  return rowToClip(row);
}
