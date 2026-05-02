import { getProjectDatabase, persistProjectDatabase } from "./connection";
import type {
  ComposerPlaybackQuality,
  ComposerSequencePreview,
  ComposerSequencePreviewInvalidationCause,
  ComposerSequencePreviewRequest,
  ComposerSequencePreviewStatus,
} from "../../../src/composer/types/project";

function parseRequest(value: unknown): ComposerSequencePreviewRequest {
  const fallback: ComposerSequencePreviewRequest = {
    version: 1,
    timelineSignature: "",
    duration: 0,
    fps: 30,
    projectWidth: 0,
    projectHeight: 0,
    playbackQuality: "med",
  };

  try {
    const parsed = JSON.parse((value as string) || "{}") as Partial<ComposerSequencePreviewRequest>;
    return {
      version: parsed.version ?? fallback.version,
      timelineSignature: parsed.timelineSignature ?? fallback.timelineSignature,
      duration: parsed.duration ?? fallback.duration,
      fps: parsed.fps ?? fallback.fps,
      projectWidth: parsed.projectWidth ?? fallback.projectWidth,
      projectHeight: parsed.projectHeight ?? fallback.projectHeight,
      playbackQuality: parsed.playbackQuality ?? fallback.playbackQuality,
    };
  } catch {
    return fallback;
  }
}

function parseInvalidationReasons(
  value: unknown,
): ComposerSequencePreviewInvalidationCause[] {
  try {
    const parsed = JSON.parse((value as string) || "[]") as unknown[];
    return parsed.filter(
      (
        cause,
      ): cause is ComposerSequencePreviewInvalidationCause =>
        cause === "timeline" ||
        cause === "dimensions" ||
        cause === "playback-quality",
    );
  } catch {
    return [];
  }
}

function rowToSequencePreview(row: unknown[]): ComposerSequencePreview {
  return {
    status: row[0] as ComposerSequencePreviewStatus,
    requestSignature: (row[1] as string) || "",
    request: parseRequest(row[2]),
    filePath: (row[3] as string | null) ?? null,
    playbackQuality: ((row[4] as string) || "med") as ComposerPlaybackQuality,
    invalidationReasons: parseInvalidationReasons(row[5]),
    errorMessage: (row[6] as string | null) ?? undefined,
    createdAt: row[7] as string,
    updatedAt: row[8] as string,
    lastRequestedAt: (row[9] as string | null) ?? undefined,
    startedAt: (row[10] as string | null) ?? undefined,
    completedAt: (row[11] as string | null) ?? undefined,
    invalidatedAt: (row[12] as string | null) ?? undefined,
  };
}

const SELECT_COLUMNS = `
  status,
  request_signature,
  request_json,
  file_path,
  playback_quality,
  invalidation_reasons,
  error_message,
  created_at,
  updated_at,
  last_requested_at,
  started_at,
  completed_at,
  invalidated_at
`;

export function getStoredSequencePreview(
  projectId: string,
): ComposerSequencePreview | null {
  const db = getProjectDatabase(projectId);
  if (!db) throw new Error(`Project ${projectId} is not open`);

  const result = db.exec(
    `SELECT ${SELECT_COLUMNS} FROM sequence_preview WHERE id = 1 LIMIT 1`,
  );
  const row = result[0]?.values?.[0];
  return row ? rowToSequencePreview(row) : null;
}

export function saveStoredSequencePreview(
  projectId: string,
  record: ComposerSequencePreview,
): ComposerSequencePreview {
  const db = getProjectDatabase(projectId);
  if (!db) throw new Error(`Project ${projectId} is not open`);

  db.run(
    `INSERT INTO sequence_preview (
       id,
       status,
       request_signature,
       request_json,
       file_path,
       playback_quality,
       invalidation_reasons,
       error_message,
       created_at,
       updated_at,
       last_requested_at,
       started_at,
       completed_at,
       invalidated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status,
       request_signature = excluded.request_signature,
       request_json = excluded.request_json,
       file_path = excluded.file_path,
       playback_quality = excluded.playback_quality,
       invalidation_reasons = excluded.invalidation_reasons,
       error_message = excluded.error_message,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       last_requested_at = excluded.last_requested_at,
       started_at = excluded.started_at,
       completed_at = excluded.completed_at,
       invalidated_at = excluded.invalidated_at`,
    [
      1,
      record.status,
      record.requestSignature,
      JSON.stringify(record.request),
      record.filePath,
      record.playbackQuality,
      JSON.stringify(record.invalidationReasons),
      record.errorMessage ?? null,
      record.createdAt,
      record.updatedAt,
      record.lastRequestedAt ?? null,
      record.startedAt ?? null,
      record.completedAt ?? null,
      record.invalidatedAt ?? null,
    ],
  );

  persistProjectDatabase(projectId);
  return record;
}
