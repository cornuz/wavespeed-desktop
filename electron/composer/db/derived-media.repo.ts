import { existsSync, rmSync } from "fs";
import { v4 as uuid } from "uuid";
import { getProjectDatabase, persistProjectDatabase } from "./connection";

export type DerivedMediaStatus = "processing" | "ready" | "error";

export interface DerivedMediaRecord {
  id: string;
  upstreamAssetId: string | null;
  parentDerivedMediaId: string | null;
  dependencyAssetId: string | null;
  operationType: string;
  operationLabel: string;
  specJson: string;
  cacheKey: string;
  outputPath: string | null;
  status: DerivedMediaStatus;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

function rowToDerivedMedia(row: unknown[]): DerivedMediaRecord {
  return {
    id: row[0] as string,
    upstreamAssetId: (row[1] as string | null) ?? null,
    parentDerivedMediaId: (row[2] as string | null) ?? null,
    dependencyAssetId: (row[3] as string | null) ?? null,
    operationType: row[4] as string,
    operationLabel: row[5] as string,
    specJson: (row[6] as string) ?? "{}",
    cacheKey: row[7] as string,
    outputPath: (row[8] as string | null) ?? null,
    status: row[9] as DerivedMediaStatus,
    errorMessage: (row[10] as string | null) ?? null,
    createdAt: row[11] as string,
    updatedAt: row[12] as string,
  };
}

const SELECT_COLUMNS = `
  id, upstream_asset_id, parent_derived_media_id, dependency_asset_id,
  operation_type, operation_label, spec_json, cache_key, output_path,
  status, error_message, created_at, updated_at
`;

function getDb(projectId: string) {
  const db = getProjectDatabase(projectId);
  if (!db) {
    throw new Error(`Project ${projectId} is not open`);
  }
  return db;
}

export function listDerivedMedia(projectId: string): DerivedMediaRecord[] {
  const db = getDb(projectId);
  const result = db.exec(`SELECT ${SELECT_COLUMNS} FROM derived_media ORDER BY created_at ASC`);
  return (result[0]?.values ?? []).map(rowToDerivedMedia);
}

export function getDerivedMediaById(projectId: string, id: string): DerivedMediaRecord | null {
  const db = getDb(projectId);
  const result = db.exec(`SELECT ${SELECT_COLUMNS} FROM derived_media WHERE id = ? LIMIT 1`, [id]);
  const row = result[0]?.values?.[0];
  return row ? rowToDerivedMedia(row) : null;
}

export function getDerivedMediaByCacheKey(
  projectId: string,
  cacheKey: string,
): DerivedMediaRecord | null {
  const db = getDb(projectId);
  const result = db.exec(
    `SELECT ${SELECT_COLUMNS} FROM derived_media WHERE cache_key = ? LIMIT 1`,
    [cacheKey],
  );
  const row = result[0]?.values?.[0];
  return row ? rowToDerivedMedia(row) : null;
}

export function createDerivedMedia(
  projectId: string,
  input: Omit<DerivedMediaRecord, "id" | "createdAt" | "updatedAt"> & { id?: string },
): DerivedMediaRecord {
  const db = getDb(projectId);
  const now = new Date().toISOString();
  const id = input.id ?? uuid();
  db.run(
    `INSERT INTO derived_media (
      id, upstream_asset_id, parent_derived_media_id, dependency_asset_id,
      operation_type, operation_label, spec_json, cache_key, output_path,
      status, error_message, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.upstreamAssetId ?? null,
      input.parentDerivedMediaId ?? null,
      input.dependencyAssetId ?? null,
      input.operationType,
      input.operationLabel,
      input.specJson,
      input.cacheKey,
      input.outputPath ?? null,
      input.status,
      input.errorMessage ?? null,
      now,
      now,
    ],
  );
  persistProjectDatabase(projectId);
  return getDerivedMediaById(projectId, id)!;
}

export function updateDerivedMedia(
  projectId: string,
  id: string,
  patch: Partial<
    Pick<
      DerivedMediaRecord,
      | "upstreamAssetId"
      | "parentDerivedMediaId"
      | "dependencyAssetId"
      | "operationType"
      | "operationLabel"
      | "specJson"
      | "cacheKey"
      | "outputPath"
      | "status"
      | "errorMessage"
    >
  >,
): DerivedMediaRecord {
  const db = getDb(projectId);
  const fields: string[] = [];
  const values: unknown[] = [];

  if ("upstreamAssetId" in patch) { fields.push("upstream_asset_id = ?"); values.push(patch.upstreamAssetId ?? null); }
  if ("parentDerivedMediaId" in patch) { fields.push("parent_derived_media_id = ?"); values.push(patch.parentDerivedMediaId ?? null); }
  if ("dependencyAssetId" in patch) { fields.push("dependency_asset_id = ?"); values.push(patch.dependencyAssetId ?? null); }
  if ("operationType" in patch) { fields.push("operation_type = ?"); values.push(patch.operationType); }
  if ("operationLabel" in patch) { fields.push("operation_label = ?"); values.push(patch.operationLabel); }
  if ("specJson" in patch) { fields.push("spec_json = ?"); values.push(patch.specJson); }
  if ("cacheKey" in patch) { fields.push("cache_key = ?"); values.push(patch.cacheKey); }
  if ("outputPath" in patch) { fields.push("output_path = ?"); values.push(patch.outputPath ?? null); }
  if ("status" in patch) { fields.push("status = ?"); values.push(patch.status); }
  if ("errorMessage" in patch) { fields.push("error_message = ?"); values.push(patch.errorMessage ?? null); }

  if (fields.length > 0) {
    fields.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(id);
    db.run(`UPDATE derived_media SET ${fields.join(", ")} WHERE id = ?`, values);
    persistProjectDatabase(projectId);
  }

  return getDerivedMediaById(projectId, id)!;
}

export function listDerivedMediaIdsByAssetDependency(projectId: string, assetId: string): string[] {
  const rows = listDerivedMedia(projectId);
  const direct = rows
    .filter(
      (row) => row.upstreamAssetId === assetId || row.dependencyAssetId === assetId,
    )
    .map((row) => row.id);
  if (direct.length === 0) {
    return [];
  }

  const allIds = new Set(direct);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (
        row.parentDerivedMediaId &&
        allIds.has(row.parentDerivedMediaId) &&
        !allIds.has(row.id)
      ) {
        allIds.add(row.id);
        changed = true;
      }
    }
  }

  return [...allIds];
}

export function deleteDerivedMediaByIds(projectId: string, ids: string[]): void {
  if (ids.length === 0) {
    return;
  }

  const db = getDb(projectId);
  const records = ids
    .map((id) => getDerivedMediaById(projectId, id))
    .filter((row): row is DerivedMediaRecord => row != null);

  for (const record of records) {
    if (record.outputPath && existsSync(record.outputPath)) {
      try {
        rmSync(record.outputPath, { force: true });
      } catch (error) {
        console.warn(`[Composer] Failed to delete derived media output ${record.outputPath}:`, error);
      }
    }
  }

  const placeholders = ids.map(() => "?").join(", ");
  db.run(`DELETE FROM derived_media WHERE id IN (${placeholders})`, ids);
  persistProjectDatabase(projectId);
}
