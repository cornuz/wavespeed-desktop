import { spawn } from "child_process";
import { createHash } from "crypto";
import { BrowserWindow } from "electron";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "fs";
import { extname, join, normalize, resolve } from "path";
import stringify from "json-stable-stringify";
import { getCanvasBlendMode } from "../../src/composer/shared/blend-modes";
import { normalizeClipAdjustments } from "../../src/composer/shared/clipAdjustments";
import { buildCssFilter as buildSharedCssFilter } from "../../src/composer/shared/filter-builder";
import { getUniversalClipRect, universalRectToScreen } from "../../src/composer/shared/compositionGeometry";
import type {
  Clip,
  ComposerPlaybackQuality,
  ComposerSequencePreview,
  ComposerSequencePreviewInvalidationCause,
  ComposerSequencePreviewRequest,
  Track,
} from "../../src/composer/types/project";
import { loadAssetMetadata } from "./asset-metadata";
import { loadRegistry } from "./db/project-registry";
import { getProjectDatabase } from "./db/connection";
import { listClips } from "./db/clips.repo";
import { listTracks } from "./db/tracks.repo";
import {
  getStoredSequencePreview,
  saveStoredSequencePreview,
} from "./db/sequence-preview.repo";
import { ensureComposerFfmpegToolsAvailable } from "./ffmpeg";
import {
  createHeadlessRenderer,
  renderSegmentInHeadlessRenderer,
  setHeadlessRendererProgressListener,
} from "./headless-renderer";
import { listProjectLuts, resolveProjectLut } from "./lut-library";
import {
  buildConcatList,
  computeOverallProgress,
  concatSegments,
  createInitialManifest,
  deleteSegments,
  getNextDirtySegment,
  isManifestReusable,
  loadSegmentManifest,
  markAllDirty,
  markDirty,
  markRendered,
  saveSegmentManifest,
  writeSegment,
} from "./segment-cache";
import type {
  HeadlessRenderClip,
  RenderSegmentProgress,
  RenderSegmentRequest,
  SegmentManifest,
  SequencePreviewProgressEvent,
} from "./sequence-preview-contract";

export const SEQUENCE_PREVIEW_REQUEST_VERSION = 8;
const SEQUENCE_PREVIEW_EDIT_DEBOUNCE_MS = 600;
const SEQUENCE_PREVIEW_RECONCILE_INTERVAL_MS = 15_000;

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"]);
const SEQUENCE_PREVIEW_SCALE_BY_QUALITY: Record<ComposerPlaybackQuality, number> = {
  full: 1,
  high: 0.85,
  med: 0.7,
  low: 0.55,
};

interface ProjectSequencePreviewSettings {
  duration: number;
  fps: number;
  width: number;
  height: number;
  playbackQuality: ComposerPlaybackQuality;
}

interface MediaProbeResult {
  hasVideo: boolean;
  hasAudio: boolean;
  width: number | null;
  height: number | null;
  duration: number | null;
}

interface ResolvedPreviewMediaSource {
  path: string;
  probe: MediaProbeResult | null;
  inputKind: "image" | "media";
  sourceIsLutProxy: boolean;
}

interface SequencePreviewRenderPlan {
  request: ComposerSequencePreviewRequest;
  requestSignature: string;
  outputPath: string;
}

interface ProjectSequencePreviewJobState {
  running: boolean;
  rerunRequested: boolean;
  scheduledTimer: ReturnType<typeof setTimeout> | null;
}

interface DirtyRange {
  startTime: number;
  endTime: number;
}

interface PendingInvalidationState {
  dirtyRange: DirtyRange | null;
  fullReset: boolean;
}

interface ClipLutSignature {
  assetId: string;
  modifiedAt: string | null;
  cacheKey: string | null;
  status: "resolved" | "error";
  errorMessage?: string;
}

const activeSequencePreviewJobs = new Map<string, ProjectSequencePreviewJobState>();
const trackedSequencePreviewProjects = new Set<string>();
const pendingSequencePreviewInvalidations = new Map<string, PendingInvalidationState>();
const sequencePreviewProgressLogBuckets = new Map<string, number>();
let sequencePreviewReconcileTimer: ReturnType<typeof setInterval> | null = null;

function buildClipLutSignature(
  projectId: string,
  lutAssetId: string | null,
  lutAssetsById: Map<string, { modifiedAt: string }>,
): ClipLutSignature | null {
  if (!lutAssetId) {
    return null;
  }

  const assetId = normalize(lutAssetId);
  const asset = lutAssetsById.get(assetId) ?? null;

  try {
    const resolved = resolveProjectLut(projectId, lutAssetId);
    if (!resolved) {
      return null;
    }

    return {
      assetId: resolved.assetId,
      modifiedAt: resolved.modifiedAt,
      cacheKey: resolved.cacheKey,
      status: "resolved",
    };
  } catch (error) {
    return {
      assetId,
      modifiedAt: asset?.modifiedAt ?? null,
      cacheKey: null,
      status: "error",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

function logSequencePreviewDebug(
  message: string,
  details?: Record<string, unknown>,
): void {
  if (details) {
    console.info(`[Composer Preview] ${message}`, details);
    return;
  }
  console.info(`[Composer Preview] ${message}`);
}

function clearSequencePreviewProgressLog(projectId: string, requestSignature: string): void {
  sequencePreviewProgressLogBuckets.delete(`${projectId}:${requestSignature}`);
}

function computeHash(input: unknown): string {
  return createHash("sha256")
    .update(stringify(input) || "{}")
    .digest("hex");
}

function normalizeEvenDimension(value: number): number {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

function clampClipDuration(value: number): number {
  return Math.max(0.04, value);
}

function clampOpacity(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(Math.max(value, 0), 1);
}

function clampFadeDuration(value: number, clipDuration: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(value, clipDuration);
}

function buildCssFilter(clip: Clip): string {
  return buildSharedCssFilter(clip.adjustments);
}

function mergeDirtyRanges(
  current: DirtyRange | null,
  next: DirtyRange | null,
): DirtyRange | null {
  if (!current) {
    return next;
  }
  if (!next) {
    return current;
  }
  return {
    startTime: Math.min(current.startTime, next.startTime),
    endTime: Math.max(current.endTime, next.endTime),
  };
}

function rememberSequencePreviewInvalidation(
  projectId: string,
  options: { dirtyRange?: DirtyRange | null; fullReset?: boolean } = {},
): void {
  const previous = pendingSequencePreviewInvalidations.get(projectId) ?? {
    dirtyRange: null,
    fullReset: false,
  };
  pendingSequencePreviewInvalidations.set(projectId, {
    dirtyRange: mergeDirtyRanges(previous.dirtyRange, options.dirtyRange ?? null),
    fullReset: previous.fullReset || options.fullReset === true,
  });
}

function consumeSequencePreviewInvalidation(
  projectId: string,
): PendingInvalidationState {
  const pending = pendingSequencePreviewInvalidations.get(projectId) ?? {
    dirtyRange: null,
    fullReset: false,
  };
  pendingSequencePreviewInvalidations.delete(projectId);
  return pending;
}

function getProjectSummary(projectId: string) {
  const summary = loadRegistry().projects.find((project) => project.id === projectId);
  if (!summary) {
    throw new Error(`Project ${projectId} not found in registry`);
  }
  return summary;
}

function getProjectAssetsDir(projectId: string): string {
  return join(getProjectSummary(projectId).path, "assets");
}

function getProjectCacheDir(projectId: string): string {
  return join(getProjectSummary(projectId).path, "cache");
}

function getLegacyProjectSequencePreviewCacheDir(projectId: string): string {
  return join(getProjectCacheDir(projectId), "sequence-preview");
}

function getProjectSequencePreviewFilePath(
  projectId: string,
  requestSignature: string,
): string {
  const cacheDir = getProjectCacheDir(projectId);
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }
  return join(cacheDir, `seqprev-${requestSignature}.mp4`);
}

function normalizeSequencePreviewPath(filePath: string): string {
  return resolve(filePath).toLowerCase();
}

function pruneProjectSequencePreviewCache(
  projectId: string,
  keepFilePath: string,
): void {
  const keptPath = normalizeSequencePreviewPath(keepFilePath);
  const cacheDir = getProjectCacheDir(projectId);
  if (existsSync(cacheDir)) {
    for (const entry of readdirSync(cacheDir, { withFileTypes: true })) {
      const entryPath = join(cacheDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "sequence-preview") {
          rmSync(entryPath, { force: true, recursive: true });
        }
        continue;
      }

      if (
        !/^seqprev-[0-9a-f]+\.mp4$/i.test(entry.name) ||
        normalizeSequencePreviewPath(entryPath) === keptPath
      ) {
        continue;
      }
      rmSync(entryPath, { force: true, recursive: true });
    }
  }

  const legacyCacheDir = getLegacyProjectSequencePreviewCacheDir(projectId);
  if (existsSync(legacyCacheDir)) {
    rmSync(legacyCacheDir, { force: true, recursive: true });
  }
}

function pruneProjectSequencePreviewCacheForCurrent(
  projectId: string,
  preview: ComposerSequencePreview,
): void {
  if (
    preview.status !== "ready" ||
    !preview.filePath ||
    !existsSync(preview.filePath)
  ) {
    return;
  }

  try {
    pruneProjectSequencePreviewCache(projectId, preview.filePath);
  } catch (error) {
    console.warn(
      `[Composer] Failed to prune sequence preview cache for project ${projectId}:`,
      error,
    );
  }
}

export function computeProjectTimelineSignature(projectId: string): string {
  const lutAssetsById = new Map(
    listProjectLuts(projectId).map((asset) => [
      normalize(asset.id),
      { modifiedAt: asset.modifiedAt },
    ]),
  );
  const tracks = listTracks(projectId).map((track) => ({
    id: track.id,
    type: track.type,
    order: track.order,
    muted: track.muted,
    visible: track.visible,
    isComposite: track.isComposite,
  }));
  const clips = listClips(projectId).map((clip) => {
    const adjustments = normalizeClipAdjustments(clip.adjustments);
    return {
      id: clip.id,
      trackId: clip.trackId,
      sourceType: clip.sourceType,
      sourcePath: clip.sourcePath,
      sourceAssetId: clip.sourceAssetId,
      derivedMediaId: clip.derivedMediaId,
      lutProxyPath: clip.lutProxyPath,
      startTime: clip.startTime,
      duration: clip.duration,
      trimStart: clip.trimStart,
      trimEnd: clip.trimEnd,
      speed: clip.speed,
      transformOffsetX: clip.transformOffsetX,
      transformOffsetY: clip.transformOffsetY,
      transformScale: clip.transformScale,
      flipHorizontal: clip.flipHorizontal,
      flipVertical: clip.flipVertical,
      rotationZ: clip.rotationZ,
      opacity: clip.opacity,
      brightness: clip.brightness,
      contrast: clip.contrast,
      saturation: clip.saturation,
      adjustments,
      lutSignature: buildClipLutSignature(
        projectId,
        adjustments.lutAssetId,
        lutAssetsById,
      ),
      fadeInDuration: clip.fadeInDuration,
      fadeOutDuration: clip.fadeOutDuration,
    };
  });

  return computeHash({ tracks, clips });
}

function getSequencePreviewOutputDimensions(
  request: ComposerSequencePreviewRequest,
): { width: number; height: number } {
  const scale = SEQUENCE_PREVIEW_SCALE_BY_QUALITY[request.playbackQuality];
  return {
    width: normalizeEvenDimension(request.projectWidth * scale),
    height: normalizeEvenDimension(request.projectHeight * scale),
  };
}

function getProjectSequencePreviewSettings(
  projectId: string,
): ProjectSequencePreviewSettings {
  const db = getProjectDatabase(projectId);
  if (!db) {
    throw new Error(`Project ${projectId} is not open`);
  }

  const result = db.exec(
    `SELECT duration, fps, width, height, playback_quality FROM meta LIMIT 1`,
  );
  const row = result[0]?.values?.[0];
  if (!row) {
    throw new Error(`Project ${projectId} meta row missing`);
  }

  return {
    duration: row[0] as number,
    fps: row[1] as number,
    width: row[2] as number,
    height: row[3] as number,
    playbackQuality: ((row[4] as string) || "med") as ComposerPlaybackQuality,
  };
}

export function buildCurrentSequencePreviewRequest(
  projectId: string,
): ComposerSequencePreviewRequest {
  const settings = getProjectSequencePreviewSettings(projectId);
  return {
    version: SEQUENCE_PREVIEW_REQUEST_VERSION,
    timelineSignature: computeProjectTimelineSignature(projectId),
    duration: settings.duration,
    fps: settings.fps,
    projectWidth: settings.width,
    projectHeight: settings.height,
    playbackQuality: settings.playbackQuality,
  };
}

function buildCurrentSequencePreviewPlan(projectId: string): SequencePreviewRenderPlan {
  const request = buildCurrentSequencePreviewRequest(projectId);
  const requestSignature = computeHash(request);
  return {
    request,
    requestSignature,
    outputPath: getProjectSequencePreviewFilePath(projectId, requestSignature),
  };
}

function buildBaseSequencePreviewRecord(
  projectId: string,
  status: ComposerSequencePreview["status"],
  invalidationReasons: ComposerSequencePreviewInvalidationCause[],
  current?: ComposerSequencePreview,
  errorMessage?: string,
): ComposerSequencePreview {
  const now = new Date().toISOString();
  const plan = buildCurrentSequencePreviewPlan(projectId);
  const shouldPreserveRequestTimestamps =
    current?.requestSignature === plan.requestSignature;

  return {
    status,
    requestSignature: plan.requestSignature,
    request: plan.request,
    filePath: plan.outputPath,
    playbackQuality: plan.request.playbackQuality,
    invalidationReasons,
    errorMessage,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
    lastRequestedAt: shouldPreserveRequestTimestamps
      ? current?.lastRequestedAt
      : undefined,
    startedAt: shouldPreserveRequestTimestamps ? current?.startedAt : undefined,
    completedAt: shouldPreserveRequestTimestamps
      ? current?.completedAt
      : undefined,
    invalidatedAt:
      invalidationReasons.length > 0 || status === "stale"
        ? now
        : current?.invalidatedAt,
  };
}

function areRequestsEqual(
  left: ComposerSequencePreviewRequest,
  right: ComposerSequencePreviewRequest,
): boolean {
  return (
    left.version === right.version &&
    left.timelineSignature === right.timelineSignature &&
    left.duration === right.duration &&
    left.fps === right.fps &&
    left.projectWidth === right.projectWidth &&
    left.projectHeight === right.projectHeight &&
    left.playbackQuality === right.playbackQuality
  );
}

function deriveInvalidationReasons(
  previous: ComposerSequencePreview | null,
  currentRequest: ComposerSequencePreviewRequest,
): ComposerSequencePreviewInvalidationCause[] {
  if (!previous) {
    return [];
  }

  const reasons = new Set<ComposerSequencePreviewInvalidationCause>();
  const previousRequest = previous.request;

  if (
    !previousRequest ||
    previousRequest.timelineSignature !== currentRequest.timelineSignature ||
    previousRequest.duration !== currentRequest.duration ||
    previousRequest.fps !== currentRequest.fps
  ) {
    reasons.add("timeline");
  }
  if (
    !previousRequest ||
    previousRequest.projectWidth !== currentRequest.projectWidth ||
    previousRequest.projectHeight !== currentRequest.projectHeight
  ) {
    reasons.add("dimensions");
  }
  if (
    !previousRequest ||
    previousRequest.playbackQuality !== currentRequest.playbackQuality
  ) {
    reasons.add("playback-quality");
  }

  return [...reasons];
}

function getOrCreateJobState(projectId: string): ProjectSequencePreviewJobState {
  const current = activeSequencePreviewJobs.get(projectId);
  if (current) {
    return current;
  }
  const created: ProjectSequencePreviewJobState = {
    running: false,
    rerunRequested: false,
    scheduledTimer: null,
  };
  activeSequencePreviewJobs.set(projectId, created);
  return created;
}

function isSequencePreviewJobActive(projectId: string): boolean {
  return activeSequencePreviewJobs.get(projectId)?.running === true;
}

function clearScheduledSequencePreviewRefresh(projectId: string): void {
  const jobState = activeSequencePreviewJobs.get(projectId);
  if (!jobState?.scheduledTimer) {
    return;
  }

  clearTimeout(jobState.scheduledTimer);
  jobState.scheduledTimer = null;
}

function shouldRefreshProjectSequencePreview(
  projectId: string,
  current: ComposerSequencePreview,
): boolean {
  return (
    current.status === "missing" ||
    current.status === "stale" ||
    current.status === "error" ||
    (current.status === "processing" && !isSequencePreviewJobActive(projectId))
  );
}

function maybeStopSequencePreviewReconcileLoop(): void {
  if (
    trackedSequencePreviewProjects.size > 0 ||
    sequencePreviewReconcileTimer == null
  ) {
    return;
  }

  clearInterval(sequencePreviewReconcileTimer);
  sequencePreviewReconcileTimer = null;
}

function reconcileProjectSequencePreview(projectId: string): void {
  const current = getProjectSequencePreview(projectId);
  if (!shouldRefreshProjectSequencePreview(projectId, current)) {
    return;
  }

  scheduleProjectSequencePreviewRefresh(projectId, { debounceMs: 0 });
}

function ensureSequencePreviewReconcileLoop(): void {
  if (sequencePreviewReconcileTimer != null) {
    return;
  }

  sequencePreviewReconcileTimer = setInterval(() => {
    for (const projectId of [...trackedSequencePreviewProjects]) {
      try {
        reconcileProjectSequencePreview(projectId);
      } catch {
        disposeProjectSequencePreview(projectId);
      }
    }
  }, SEQUENCE_PREVIEW_RECONCILE_INTERVAL_MS);

  sequencePreviewReconcileTimer.unref?.();
}

function trackProjectSequencePreview(projectId: string): void {
  trackedSequencePreviewProjects.add(projectId);
  ensureSequencePreviewReconcileLoop();
}

function broadcastSequencePreviewProgress(
  event: SequencePreviewProgressEvent,
): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue;
    }
    window.webContents.send("composer:sequence-preview-progress", event);
  }
}

export function disposeProjectSequencePreview(projectId: string): void {
  clearScheduledSequencePreviewRefresh(projectId);
  activeSequencePreviewJobs.delete(projectId);
  trackedSequencePreviewProjects.delete(projectId);
  pendingSequencePreviewInvalidations.delete(projectId);
  maybeStopSequencePreviewReconcileLoop();
}

export function getProjectSequencePreview(
  projectId: string,
): ComposerSequencePreview {
  trackProjectSequencePreview(projectId);
  const stored = getStoredSequencePreview(projectId);
  const currentPlan = buildCurrentSequencePreviewPlan(projectId);

  if (!stored) {
    const created = buildBaseSequencePreviewRecord(projectId, "missing", []);
    return saveStoredSequencePreview(projectId, created);
  }

  const currentMatchesStored =
    stored.requestSignature.length > 0 &&
    areRequestsEqual(stored.request, currentPlan.request) &&
    stored.requestSignature === currentPlan.requestSignature;

  if (!currentMatchesStored) {
    if (stored.requestSignature.length === 0 && stored.status === "missing") {
      const initialized = buildBaseSequencePreviewRecord(
        projectId,
        "missing",
        [],
        stored,
      );
      return saveStoredSequencePreview(projectId, initialized);
    }

    const invalidationReasons = deriveInvalidationReasons(
      stored,
      currentPlan.request,
    );
    const nextStatus =
      stored.status === "missing" && !stored.filePath && !stored.completedAt
        ? "missing"
        : "stale";
    const reconciled = buildBaseSequencePreviewRecord(
      projectId,
      nextStatus,
      invalidationReasons,
      stored,
    );
    return saveStoredSequencePreview(projectId, reconciled);
  }

  if (
    stored.status === "ready" &&
    stored.filePath &&
    !existsSync(stored.filePath)
  ) {
    const missing = buildBaseSequencePreviewRecord(
      projectId,
      "missing",
      [],
      stored,
    );
    return saveStoredSequencePreview(projectId, missing);
  }

  if (
    stored.filePath !==
    getProjectSequencePreviewFilePath(projectId, stored.requestSignature)
  ) {
    const normalized = {
      ...stored,
      filePath: getProjectSequencePreviewFilePath(projectId, stored.requestSignature),
    };
    const saved = saveStoredSequencePreview(projectId, normalized);
    pruneProjectSequencePreviewCacheForCurrent(projectId, saved);
    return saved;
  }

  pruneProjectSequencePreviewCacheForCurrent(projectId, stored);
  return stored;
}

export function invalidateProjectSequencePreview(
  projectId: string,
  causes: ComposerSequencePreviewInvalidationCause[],
  options: { dirtyRange?: DirtyRange | null; fullReset?: boolean } = {},
): ComposerSequencePreview {
  const current = getProjectSequencePreview(projectId);
  rememberSequencePreviewInvalidation(projectId, options);
  const dedupedCauses = Array.from(
    new Set([...current.invalidationReasons, ...causes]),
  );
  const nextStatus =
    current.status === "missing" && !current.completedAt && !current.startedAt
      ? "missing"
      : "stale";
  const invalidated = buildBaseSequencePreviewRecord(
    projectId,
    nextStatus,
    dedupedCauses,
    current,
  );
  return saveStoredSequencePreview(projectId, invalidated);
}

function markProjectSequencePreviewProcessing(
  projectId: string,
  current: ComposerSequencePreview,
): ComposerSequencePreview {
  const now = new Date().toISOString();
  const processing = saveStoredSequencePreview(projectId, {
    ...current,
    status: "processing",
    errorMessage: undefined,
    invalidationReasons: [],
    updatedAt: now,
    lastRequestedAt: now,
    startedAt: now,
    filePath:
      current.filePath ??
      getProjectSequencePreviewFilePath(projectId, current.requestSignature),
  });
  broadcastSequencePreviewProgress({
    projectId,
    requestSignature: processing.requestSignature,
    status: "processing",
    overallPercent: 0,
    segmentIndex: null,
    totalSegments: 0,
    segmentPercent: null,
    frameIndex: null,
    totalFrames: null,
    updatedAt: now,
  });
  clearSequencePreviewProgressLog(projectId, processing.requestSignature);
  logSequencePreviewDebug("job marked processing", {
    projectId,
    requestSignature: processing.requestSignature,
    playbackQuality: processing.playbackQuality,
    outputPath: processing.filePath,
  });
  return processing;
}

function markProjectSequencePreviewReadyForSignature(
  projectId: string,
  requestSignature: string,
  filePath: string,
): ComposerSequencePreview {
  const current = getProjectSequencePreview(projectId);
  if (current.requestSignature !== requestSignature) {
    return current;
  }
  const now = new Date().toISOString();
  const ready = saveStoredSequencePreview(projectId, {
    ...current,
    status: "ready",
    filePath,
    errorMessage: undefined,
    invalidationReasons: [],
    updatedAt: now,
    completedAt: now,
  });
  broadcastSequencePreviewProgress({
    projectId,
    requestSignature,
    status: "ready",
    overallPercent: 100,
    segmentIndex: null,
    totalSegments: 0,
    segmentPercent: null,
    frameIndex: null,
    totalFrames: null,
    updatedAt: now,
  });
  clearSequencePreviewProgressLog(projectId, requestSignature);
  logSequencePreviewDebug("job ready", {
    projectId,
    requestSignature,
    filePath,
  });
  return ready;
}

function markProjectSequencePreviewErrorForSignature(
  projectId: string,
  requestSignature: string,
  errorMessage: string,
): ComposerSequencePreview {
  const current = getProjectSequencePreview(projectId);
  if (current.requestSignature !== requestSignature) {
    return current;
  }
  const now = new Date().toISOString();
  const failed = saveStoredSequencePreview(projectId, {
    ...current,
    status: "error",
    errorMessage,
    invalidationReasons: [],
    updatedAt: now,
    completedAt: now,
    lastRequestedAt: current.lastRequestedAt ?? now,
  });
  broadcastSequencePreviewProgress({
    projectId,
    requestSignature,
    status: "error",
    overallPercent: 0,
    segmentIndex: null,
    totalSegments: 0,
    segmentPercent: null,
    frameIndex: null,
    totalFrames: null,
    updatedAt: now,
    errorMessage,
  });
  clearSequencePreviewProgressLog(projectId, requestSignature);
  logSequencePreviewDebug("job errored", {
    projectId,
    requestSignature,
    errorMessage,
  });
  return failed;
}

function runFfprobe(filePath: string): Promise<MediaProbeResult | null> {
  return new Promise<MediaProbeResult | null>((resolveResult) => {
    const proc = spawn(
      "ffprobe",
      ["-v", "quiet", "-of", "json", "-show_format", "-show_streams", filePath],
      { windowsHide: true },
    );

    let stdout = "";
    let settled = false;

    const finish = (value: MediaProbeResult | null) => {
      if (settled) {
        return;
      }
      settled = true;
      resolveResult(value);
    };

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    proc.once("error", () => finish(null));
    proc.once("exit", (code) => {
      if (code !== 0) {
        finish(null);
        return;
      }

      try {
        const parsed = JSON.parse(stdout) as {
          streams?: Array<{
            codec_type?: string;
            width?: number;
            height?: number;
            duration?: string;
          }>;
          format?: { duration?: string };
        };
        const streams = parsed.streams ?? [];
        const videoStream = streams.find((stream) => stream.codec_type === "video");
        const audioStream = streams.find((stream) => stream.codec_type === "audio");
        const durationCandidates = [
          parsed.format?.duration,
          videoStream?.duration,
          audioStream?.duration,
        ]
          .map((value) => (value != null ? Number(value) : null))
          .filter(
            (value): value is number =>
              value != null && Number.isFinite(value) && value > 0,
          );

        finish({
          hasVideo: videoStream != null,
          hasAudio: audioStream != null,
          width: videoStream?.width ?? null,
          height: videoStream?.height ?? null,
          duration: durationCandidates[0] ?? null,
        });
      } catch {
        finish(null);
      }
    });
  });
}

function buildClipSourceDuration(clip: Clip, probe: MediaProbeResult | null): number {
  const desiredSourceDuration = clip.duration * Math.max(clip.speed, 0.01);
  if (!probe?.duration || clip.trimEnd == null) {
    return clampClipDuration(desiredSourceDuration);
  }

  const availableDuration = Math.max(
    0,
    probe.duration - clip.trimStart - Math.max(clip.trimEnd, 0),
  );
  return clampClipDuration(Math.min(desiredSourceDuration, availableDuration));
}

function computeClipRenderedDuration(
  clip: Clip,
  clipSourceDuration: number,
  clipVisibleDuration: number,
  inputKind: ResolvedPreviewMediaSource["inputKind"],
): number {
  if (inputKind === "image") {
    return clipVisibleDuration;
  }

  return clampClipDuration(
    Math.min(
      clipVisibleDuration,
      clipSourceDuration / Math.max(clip.speed, 0.01),
    ),
  );
}

function computeRenderedVideoPlacement(
  probe: MediaProbeResult | null,
  outputWidth: number,
  outputHeight: number,
  projectWidth: number,
  projectHeight: number,
  clip: Clip,
): { width: number; height: number; x: number; y: number } {
  const sourceWidth = probe?.width && probe.width > 0 ? probe.width : projectWidth;
  const sourceHeight =
    probe?.height && probe.height > 0 ? probe.height : projectHeight;
  return universalRectToScreen(
    getUniversalClipRect(
      { width: sourceWidth, height: sourceHeight },
      clip.transformOffsetX,
      clip.transformOffsetY,
      clip.transformScale,
    ),
    outputWidth / 2,
    outputHeight / 2,
    outputWidth / projectWidth,
  );
}

function parseSvgDimensions(filePath: string): { width: number; height: number } | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const viewBoxMatch = content.match(/viewBox=["']([^"']+)["']/i);
    const widthMatch = content.match(/\bwidth=["'](\d+(?:\.\d+)?)(px)?["']/i);
    const heightMatch = content.match(/\bheight=["'](\d+(?:\.\d+)?)(px)?["']/i);

    if (widthMatch && heightMatch) {
      return { width: parseFloat(widthMatch[1]), height: parseFloat(heightMatch[1]) };
    }

    if (viewBoxMatch) {
      const parts = viewBoxMatch[1].split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
        return { width: parts[2], height: parts[3] };
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function resolveClipMediaSource(
  clip: Clip,
  assetsMetadata: ReturnType<typeof loadAssetMetadata>,
  probeCache: Map<string, Promise<MediaProbeResult | null>>,
): Promise<ResolvedPreviewMediaSource | null> {
  const sourcePath = clip.sourcePath;
  if (!sourcePath) {
    return null;
  }

  const assetMetadata = assetsMetadata[sourcePath];
  const candidatePaths = [
    clip.lutProxyPath,
    assetMetadata?.workingPath,
    sourcePath,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  const selectedPath = candidatePaths.find((value) => existsSync(value));
  if (!selectedPath) {
    return null;
  }

  const extension = extname(selectedPath).toLowerCase();
  const inputKind = IMAGE_EXTS.has(extension) ? "image" : "media";
  const cachedProbe = probeCache.get(selectedPath) ?? runFfprobe(selectedPath);
  probeCache.set(selectedPath, cachedProbe);

  let probe = await cachedProbe;

  if (extension === ".svg" && (!probe || !probe.width || probe.width <= 0)) {
    const svgDims = parseSvgDimensions(selectedPath);
    if (svgDims) {
      probe = {
        ...(probe ?? {}),
        width: svgDims.width,
        height: svgDims.height,
      } as MediaProbeResult;
    }
  }

  return {
    path: selectedPath,
    probe,
    inputKind,
    sourceIsLutProxy: selectedPath === clip.lutProxyPath,
  };
}

function getOrderedClips(projectId: string): Array<{ clip: Clip; track: Track }> {
  const tracks = listTracks(projectId);
  const clips = listClips(projectId);
  const trackMap = new Map(tracks.map((track) => [track.id, track]));

  return clips
    .map((clip) => ({ clip, track: trackMap.get(clip.trackId) }))
    .filter((entry): entry is { clip: Clip; track: Track } => entry.track != null)
    .sort((left, right) => {
      if (left.track.order !== right.track.order) {
        return right.track.order - left.track.order;
      }
      if (left.clip.startTime !== right.clip.startTime) {
        return left.clip.startTime - right.clip.startTime;
      }
      return left.clip.createdAt.localeCompare(right.clip.createdAt);
    });
}

async function buildHeadlessRenderClips(
  projectId: string,
  plan: SequencePreviewRenderPlan,
): Promise<HeadlessRenderClip[]> {
  const assetsMetadata = loadAssetMetadata(getProjectAssetsDir(projectId));
  const probeCache = new Map<string, Promise<MediaProbeResult | null>>();
  const lutCache = new Map<string, HeadlessRenderClip["lut"]>();
  const outputDimensions = getSequencePreviewOutputDimensions(plan.request);
  const clips: HeadlessRenderClip[] = [];

  for (const { clip, track } of getOrderedClips(projectId)) {
    if (!clip.sourcePath || clip.duration <= 0 || clip.startTime >= plan.request.duration) {
      continue;
    }

    const resolvedSource = await resolveClipMediaSource(
      clip,
      assetsMetadata,
      probeCache,
    );
    if (!resolvedSource) {
      continue;
    }

    const clipVisibleDuration = clampClipDuration(
      Math.min(clip.duration, Math.max(0.04, plan.request.duration - clip.startTime)),
    );
    const clipSourceDuration =
      resolvedSource.inputKind === "image"
        ? clipVisibleDuration
        : buildClipSourceDuration(clip, resolvedSource.probe);
    const clipRenderedDuration = computeClipRenderedDuration(
      clip,
      clipSourceDuration,
      clipVisibleDuration,
      resolvedSource.inputKind,
    );

    const adjustments = normalizeClipAdjustments(clip.adjustments);
    const requestedLutAssetId = adjustments.lutAssetId;
    const resolvedLut =
      requestedLutAssetId &&
      resolvedSource.inputKind === "image" &&
      !resolvedSource.sourceIsLutProxy
        ? (() => {
            const lutCacheKey = normalize(requestedLutAssetId);
            if (lutCache.has(lutCacheKey)) {
              return lutCache.get(lutCacheKey) ?? null;
            }

            try {
              const resolved = resolveProjectLut(projectId, requestedLutAssetId);
              const value = resolved
                ? {
                    assetId: resolved.assetId,
                    cacheKey: resolved.cacheKey,
                    lut: resolved.lut,
                  }
                : null;
              lutCache.set(lutCacheKey, value);
              return value;
            } catch (error) {
              console.warn("[Composer Preview] clip LUT skipped", {
                projectId,
                clipId: clip.id,
                lutAssetId: requestedLutAssetId,
                errorMessage:
                  error instanceof Error ? error.message : String(error),
              });
              lutCache.set(lutCacheKey, null);
              return null;
            }
          })()
        : null;
    const hasVisual =
      track.type === "video" &&
      track.visible &&
      (resolvedSource.inputKind === "image" || resolvedSource.probe?.hasVideo !== false);
    const hasAudio = !track.muted && resolvedSource.probe?.hasAudio === true;
    const placement = hasVisual
      ? computeRenderedVideoPlacement(
          resolvedSource.probe,
          outputDimensions.width,
          outputDimensions.height,
          plan.request.projectWidth,
          plan.request.projectHeight,
          clip,
        )
      : null;

    clips.push({
      id: clip.id,
      sourcePath: resolvedSource.path,
      inputKind: resolvedSource.inputKind,
      startTime: clip.startTime,
      duration: clip.duration,
      renderedDuration: clipRenderedDuration,
      trimStart: clip.trimStart,
      speed: Math.max(clip.speed, 0.01),
      createdAt: clip.createdAt,
      hasVisual,
      hasAudio,
      rect: placement,
      opacity: clampOpacity(clip.opacity),
      blendMode: getCanvasBlendMode(adjustments.blendMode),
      filter: buildCssFilter(clip),
      requestedLutAssetId,
      lutApplication: resolvedLut ? "cube-image" : "none",
      lut: resolvedLut,
      flipHorizontal: clip.flipHorizontal,
      flipVertical: clip.flipVertical,
      rotation: clip.rotationZ,
      fadeInDuration: clampFadeDuration(clip.fadeInDuration, clipRenderedDuration),
      fadeOutDuration: clampFadeDuration(
        clip.fadeOutDuration,
        Math.max(0, clipRenderedDuration),
      ),
      sourceDuration: resolvedSource.probe?.duration ?? null,
    });
  }

  return clips;
}

function normalizeManifest(manifest: SegmentManifest): SegmentManifest {
  return {
    ...manifest,
    segments: manifest.segments.map((segment, index) => ({
      ...segment,
      index,
      dirty: segment.dirty || !segment.file || !existsSync(segment.file),
      file:
        typeof segment.file === "string" && existsSync(segment.file)
          ? segment.file
          : null,
    })),
  };
}

function prepareSegmentManifest(
  projectId: string,
  plan: SequencePreviewRenderPlan,
  pendingInvalidation: PendingInvalidationState,
): SegmentManifest {
  const outputDimensions = getSequencePreviewOutputDimensions(plan.request);
  const existingManifest = normalizeManifest(
    loadSegmentManifest(projectId) ??
      createInitialManifest(
        plan.request.duration,
        outputDimensions.width,
        outputDimensions.height,
        plan.request.fps,
        plan.requestSignature,
      ),
  );

  const reusable = isManifestReusable(existingManifest, {
    duration: plan.request.duration,
    outputWidth: outputDimensions.width,
    outputHeight: outputDimensions.height,
    fps: plan.request.fps,
  });

  let manifest = reusable
    ? { ...existingManifest, requestSignature: plan.requestSignature }
    : createInitialManifest(
        plan.request.duration,
        outputDimensions.width,
        outputDimensions.height,
        plan.request.fps,
        plan.requestSignature,
      );

  if (!reusable || pendingInvalidation.fullReset) {
    manifest = createInitialManifest(
      plan.request.duration,
      outputDimensions.width,
      outputDimensions.height,
      plan.request.fps,
      plan.requestSignature,
    );
  } else if (
    existingManifest.requestSignature !== plan.requestSignature &&
    pendingInvalidation.dirtyRange == null
  ) {
    manifest = markAllDirty(manifest);
  }

  if (pendingInvalidation.dirtyRange) {
    manifest = markDirty(
      manifest,
      pendingInvalidation.dirtyRange.startTime,
      pendingInvalidation.dirtyRange.endTime,
    );
  }

  return saveSegmentManifest(projectId, manifest);
}

async function renderProjectSequencePreview(
  projectId: string,
  plan: SequencePreviewRenderPlan,
): Promise<void> {
  await ensureComposerFfmpegToolsAvailable();
  await createHeadlessRenderer();

  const currentPreview = getProjectSequencePreview(projectId);
  const pendingInvalidation = consumeSequencePreviewInvalidation(projectId);
  let manifest = prepareSegmentManifest(projectId, plan, pendingInvalidation);
  const renderClips = await buildHeadlessRenderClips(projectId, plan);
  logSequencePreviewDebug("render plan prepared", {
    projectId,
    requestSignature: plan.requestSignature,
    playbackQuality: plan.request.playbackQuality,
    duration: plan.request.duration,
    fps: plan.request.fps,
    outputPath: plan.outputPath,
    clipCount: renderClips.length,
    segmentCount: manifest.segments.length,
    dirtySegmentCount: manifest.segments.filter((segment) => segment.dirty).length,
  });

  const emitSegmentProgress = (progress: RenderSegmentProgress) => {
    const totalSegments = manifest.segments.length;
    const overallPercent = computeOverallProgress(
      manifest,
      progress.segmentId,
      progress.percent,
    );
    broadcastSequencePreviewProgress({
      projectId,
      requestSignature: plan.requestSignature,
      status: "processing",
      overallPercent,
      segmentIndex: progress.segmentIndex,
      totalSegments,
      segmentPercent: progress.percent,
      frameIndex: progress.frameIndex,
      totalFrames: progress.totalFrames,
      updatedAt: new Date().toISOString(),
    });
    const logKey = `${projectId}:${plan.requestSignature}`;
    const progressBucket = Math.floor(clampOpacity(overallPercent / 100) * 10);
    if (sequencePreviewProgressLogBuckets.get(logKey) !== progressBucket) {
      sequencePreviewProgressLogBuckets.set(logKey, progressBucket);
      logSequencePreviewDebug("progress", {
        projectId,
        requestSignature: plan.requestSignature,
        overallPercent: Number(overallPercent.toFixed(1)),
        segmentIndex: progress.segmentIndex + 1,
        totalSegments,
        frameIndex: progress.frameIndex,
        totalFrames: progress.totalFrames,
      });
    }
  };

  setHeadlessRendererProgressListener(emitSegmentProgress);

  try {
    while (true) {
      const segment = getNextDirtySegment(manifest);
      if (!segment) {
        break;
      }

      const request: RenderSegmentRequest = {
        projectId,
        requestSignature: plan.requestSignature,
        playbackQuality: plan.request.playbackQuality,
        segmentId: segment.id,
        segmentIndex: segment.index,
        startTime: segment.startTime,
        endTime: segment.endTime,
        outputWidth: manifest.outputWidth,
        outputHeight: manifest.outputHeight,
        fps: manifest.fps,
        clips: renderClips,
      };

      logSequencePreviewDebug("rendering segment", {
        projectId,
        requestSignature: plan.requestSignature,
        segmentId: segment.id,
        segmentIndex: segment.index + 1,
        totalSegments: manifest.segments.length,
        startTime: segment.startTime,
        endTime: segment.endTime,
      });
      const buffer = await renderSegmentInHeadlessRenderer(request);
      const filePath = writeSegment(projectId, segment, buffer);
      manifest = markRendered(manifest, segment.id, filePath);
      saveSegmentManifest(projectId, manifest);
      logSequencePreviewDebug("segment rendered", {
        projectId,
        requestSignature: plan.requestSignature,
        segmentId: segment.id,
        segmentIndex: segment.index + 1,
        totalSegments: manifest.segments.length,
        filePath,
      });
      deleteSegments(
        projectId,
        buildConcatList(manifest),
      );
    }
  } finally {
    setHeadlessRendererProgressListener(null);
  }

  const segmentPaths = buildConcatList(manifest);
  logSequencePreviewDebug("concatenating segments", {
    projectId,
    requestSignature: plan.requestSignature,
    segmentCount: segmentPaths.length,
    outputPath: plan.outputPath,
  });
  await concatSegments(segmentPaths, plan.outputPath);
  deleteSegments(projectId, segmentPaths);
  logSequencePreviewDebug("concat completed", {
    projectId,
    requestSignature: plan.requestSignature,
    outputPath: plan.outputPath,
  });

  if (
    currentPreview.requestSignature !== plan.requestSignature &&
    existsSync(plan.outputPath)
  ) {
    const latestPreview = getProjectSequencePreview(projectId);
    if (latestPreview.requestSignature !== plan.requestSignature) {
      rmSync(plan.outputPath, { force: true });
      return;
    }
  }
}

async function runProjectSequencePreviewJob(
  projectId: string,
  plan: SequencePreviewRenderPlan,
): Promise<void> {
  const jobStart = performance.now();
  try {
    await renderProjectSequencePreview(projectId, plan);
    const elapsed = ((performance.now() - jobStart) / 1000).toFixed(2);
    logSequencePreviewDebug("job completed", {
      projectId,
      requestSignature: plan.requestSignature,
      durationSeconds: elapsed,
    });
    const readyPreview = markProjectSequencePreviewReadyForSignature(
      projectId,
      plan.requestSignature,
      plan.outputPath,
    );
    if (
      readyPreview.status === "ready" &&
      readyPreview.requestSignature === plan.requestSignature &&
      readyPreview.filePath === plan.outputPath
    ) {
      pruneProjectSequencePreviewCache(projectId, plan.outputPath);
    } else if (existsSync(plan.outputPath)) {
      rmSync(plan.outputPath, { force: true });
    }
  } catch (error) {
    const elapsed = ((performance.now() - jobStart) / 1000).toFixed(2);
    const message =
      error instanceof Error ? error.message : "Failed to generate sequence preview";
    logSequencePreviewDebug("job errored", {
      projectId,
      requestSignature: plan.requestSignature,
      durationSeconds: elapsed,
      error: message,
    });
    try {
      if (existsSync(plan.outputPath)) {
        rmSync(plan.outputPath, { force: true });
      }
    } catch {
      /* ignore cleanup failure */
    }
    markProjectSequencePreviewErrorForSignature(
      projectId,
      plan.requestSignature,
      message,
    );
  }
}

function startProjectSequencePreviewJob(projectId: string): ComposerSequencePreview {
  const current = getProjectSequencePreview(projectId);
  const processing = markProjectSequencePreviewProcessing(projectId, current);
  const plan: SequencePreviewRenderPlan = {
    request: processing.request,
    requestSignature: processing.requestSignature,
    outputPath:
      processing.filePath ??
      getProjectSequencePreviewFilePath(projectId, processing.requestSignature),
  };
  const jobState = getOrCreateJobState(projectId);
  clearScheduledSequencePreviewRefresh(projectId);
  jobState.running = true;
  jobState.rerunRequested = false;
  logSequencePreviewDebug("starting job", {
    projectId,
    requestSignature: processing.requestSignature,
    status: current.status,
    outputPath: plan.outputPath,
  });

  void runProjectSequencePreviewJob(projectId, plan)
    .catch((error) => {
      console.error(
        `[Composer] Sequence preview job failed for project ${projectId}:`,
        error,
      );
    })
    .finally(() => {
      const latestState = getOrCreateJobState(projectId);
      latestState.running = false;
      if (!trackedSequencePreviewProjects.has(projectId)) {
        activeSequencePreviewJobs.delete(projectId);
        return;
      }
      const needsRerun =
        latestState.rerunRequested ||
        (() => {
          try {
            const latestPreview = getProjectSequencePreview(projectId);
            return latestPreview.status === "missing" || latestPreview.status === "stale";
          } catch {
            return false;
          }
        })();
      latestState.rerunRequested = false;

      if (needsRerun) {
        try {
          scheduleProjectSequencePreviewRefresh(projectId);
        } catch (error) {
          console.error(
            `[Composer] Failed to restart sequence preview job for project ${projectId}:`,
            error,
          );
        }
      }
    });

  return processing;
}

export function scheduleProjectSequencePreviewRefresh(
  projectId: string,
  options: {
    debounceMs?: number;
  } = {},
): ComposerSequencePreview {
  trackProjectSequencePreview(projectId);
  const current = getProjectSequencePreview(projectId);
  const needsWork = shouldRefreshProjectSequencePreview(projectId, current);
  logSequencePreviewDebug("schedule refresh", {
    projectId,
    status: current.status,
    requestSignature: current.requestSignature,
    needsWork,
    debounceMs: options.debounceMs ?? SEQUENCE_PREVIEW_EDIT_DEBOUNCE_MS,
  });

  if (!needsWork) {
    clearScheduledSequencePreviewRefresh(projectId);
    return current;
  }

  const jobState = getOrCreateJobState(projectId);
  if (jobState.running) {
    jobState.rerunRequested = true;
    return current;
  }

  const debounceMs =
    current.status === "processing"
      ? 0
      : Math.max(0, options.debounceMs ?? SEQUENCE_PREVIEW_EDIT_DEBOUNCE_MS);

  if (debounceMs === 0) {
    clearScheduledSequencePreviewRefresh(projectId);
    return startProjectSequencePreviewJob(projectId);
  }

  clearScheduledSequencePreviewRefresh(projectId);
  jobState.scheduledTimer = setTimeout(() => {
    jobState.scheduledTimer = null;

    try {
      const latest = getProjectSequencePreview(projectId);
      if (!shouldRefreshProjectSequencePreview(projectId, latest)) {
        return;
      }
      if (jobState.running) {
        jobState.rerunRequested = true;
        return;
      }
      startProjectSequencePreviewJob(projectId);
    } catch (error) {
      console.error(
        `[Composer] Failed to schedule sequence preview job for project ${projectId}:`,
        error,
      );
    }
  }, debounceMs);
  jobState.scheduledTimer.unref?.();

  return current;
}

export function ensureProjectSequencePreview(
  projectId: string,
): ComposerSequencePreview {
  return scheduleProjectSequencePreviewRefresh(projectId, { debounceMs: 0 });
}

export function buildDirtyRangeForClip(clip: Pick<Clip, "startTime" | "duration">): DirtyRange {
  return {
    startTime: Math.max(0, clip.startTime),
    endTime: Math.max(clip.startTime, clip.startTime + Math.max(0.04, clip.duration)),
  };
}
