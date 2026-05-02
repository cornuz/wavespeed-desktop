import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type DragEvent,
} from "react";
import {
  Film,
  FileImage,
  FileVideo,
  FolderHeart,
  Import,
  Lock,
  Loader2,
  Music2,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { composerAssetIpc, composerClipIpc } from "@/composer/ipc/ipc-client";
import { useComposerProjectStore } from "@/composer/stores/project.store";
import type {
  ComposerAsset,
  ComposerAssetImportProgress,
} from "@/composer/types/project";
import { cn } from "@/lib/utils";
import { MyAssetsPickerDialog } from "./MyAssetsPickerDialog";
import { useComposerRuntime } from "../context/ComposerRuntimeContext";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function getAssetIcon(type: ComposerAsset["type"]) {
  switch (type) {
    case "image":
      return FileImage;
    case "video":
      return FileVideo;
    case "audio":
      return Music2;
  }
}

function formatDuration(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return "0:00:00";
  }

  const totalSeconds = Math.floor(value);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

interface AssetDetails {
  summary: string;
  thumbnailUrl?: string;
  sourcePath: string;
}

function clampProgress(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(100, Math.max(0, value ?? 0));
}

interface AssetProgressViewModel {
  label: string;
  detail: string;
  progress: number;
  stageValue: number;
  stageTag: string;
}

function getAssetProgressViewModel(
  asset: ComposerAsset,
): AssetProgressViewModel | null {
  const importProgress = asset.importProgress;
  const fallbackLabel = asset.statusMessage ?? "Importing asset…";
  const fallbackDetail = asset.locked
    ? "Locked until staged import finishes"
    : "Preparing import";

  if (!importProgress) {
    if (asset.status === "processing" || asset.locked) {
      return {
        label: fallbackLabel,
        detail: fallbackDetail,
        progress: 0,
        stageValue: 0,
        stageTag: "import",
      };
    }

    return null;
  }

  const progress = clampProgress(importProgress.progress);
  const stageValue = clampProgress(importProgress.stageProgress);
  const stepDetail =
    importProgress.totalSteps > 0
      ? `Step ${Math.min(importProgress.currentStep, importProgress.totalSteps)} of ${importProgress.totalSteps}`
      : null;

  switch (importProgress.stage) {
    case "canonical":
      return {
        label: importProgress.stageLabel || "Generating full-quality media",
        detail: [stepDetail, "Canonical/full asset generation"]
          .filter(Boolean)
          .join(" • "),
        progress,
        stageValue,
        stageTag: "full",
      };
    case "proxy": {
      return {
        label: importProgress.stageLabel || "Finalizing import",
        detail: [stepDetail, "Finalizing staged import"]
          .filter(Boolean)
          .join(" • "),
        progress,
        stageValue,
        stageTag: "finalizing",
      };
    }
    case "complete":
      if (!asset.locked && asset.status !== "processing") {
        return null;
      }

      return {
        label: importProgress.stageLabel || "Finalizing import",
        detail: [stepDetail, "Unlocking asset"].filter(Boolean).join(" • "),
        progress: Math.max(progress, 100),
        stageValue: Math.max(stageValue, 100),
        stageTag: "finalizing",
      };
    case "discovered":
      return {
        label: importProgress.stageLabel || "Asset discovered",
        detail: [stepDetail, "Preparing staged import"]
          .filter(Boolean)
          .join(" • "),
        progress,
        stageValue,
        stageTag: "queued",
      };
    case "error":
      return {
        label:
          importProgress.stageLabel || asset.statusMessage || "Import failed",
        detail: [stepDetail, "Processing error"].filter(Boolean).join(" • "),
        progress,
        stageValue,
        stageTag: "error",
      };
    default:
      return {
        label: importProgress.stageLabel || fallbackLabel,
        detail: [stepDetail, fallbackDetail].filter(Boolean).join(" • "),
        progress,
        stageValue,
        stageTag: "import",
      };
  }
}

export function AssetsPanel() {
  const projectId = useComposerProjectStore(
    (state) => state.currentProject?.id ?? null,
  );
  const projectClips = useComposerProjectStore(
    (state) => state.currentProject?.clips ?? [],
  );
  const projectPath = useComposerProjectStore(
    (state) => state.currentProject?.path ?? null,
  );
  const setClips = useComposerProjectStore((state) => state.setClips);
  const { getAssetUrl, previewLibraryAsset } = useComposerRuntime();
  const [assets, setAssets] = useState<ComposerAsset[]>([]);
  const [assetDetails, setAssetDetails] = useState<
    Record<string, AssetDetails>
  >({});
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [isMyAssetsOpen, setIsMyAssetsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadAssets = useCallback(async () => {
    if (!projectId) {
      setAssets([]);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const nextAssets = await composerAssetIpc.list({ projectId });
      setAssets(nextAssets);
    } catch (err) {
      setError((err as Error).message ?? "Failed to load assets");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const handleImport = useCallback(async () => {
    if (!projectId) return;

    setImporting(true);
    setError(null);
    try {
      const nextAssets = await composerAssetIpc.import({ projectId });
      setAssets(nextAssets);
    } catch (err) {
      setError((err as Error).message ?? "Failed to import assets");
    } finally {
      setImporting(false);
    }
  }, [projectId]);

  const handleImportFromMyAssets = useCallback(
    async (sourcePaths: string[]) => {
      if (!projectId || sourcePaths.length === 0) return;

      setImporting(true);
      setError(null);
      try {
        const nextAssets = await composerAssetIpc.importFromPaths({
          projectId,
          sourcePaths,
        });
        setAssets(nextAssets);
        setIsMyAssetsOpen(false);
      } catch (err) {
        setError((err as Error).message ?? "Failed to import My Assets");
      } finally {
        setImporting(false);
      }
    },
    [projectId],
  );

  const handleDragStart = useCallback(
    (event: DragEvent<HTMLDivElement>, asset: ComposerAsset) => {
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData(
        "application/x-composer-asset",
        JSON.stringify(asset),
      );
      event.dataTransfer.setData("application/x-composer-asset-present", "1");
      event.dataTransfer.setData("text/plain", asset.fileName);
    },
    [],
  );

  useEffect(() => {
    let disposed = false;

    async function loadDetails(asset: ComposerAsset) {
      const detailsPath =
        asset.status === "ready" && asset.workingPath
          ? asset.workingPath
          : asset.filePath;
      const assetUrl = getAssetUrl(detailsPath);
      if (!assetUrl) {
        return;
      }

      const nextDetails = await new Promise<AssetDetails>((resolve) => {
        if (asset.type === "image") {
          const image = new Image();
          image.onload = () =>
            resolve({
              summary: `${image.naturalWidth}*${image.naturalHeight}px`,
              thumbnailUrl: assetUrl,
              sourcePath: detailsPath,
            });
          image.onerror = () =>
            resolve({
              summary: formatBytes(asset.fileSize),
              sourcePath: detailsPath,
            });
          image.src = assetUrl;
          return;
        }

        const media = document.createElement(
          asset.type === "video" ? "video" : "audio",
        );
        media.preload = "metadata";
        media.onloadedmetadata = () => {
          if (asset.type === "video") {
            resolve({
              summary: `${formatDuration(media.duration)} ${media.videoWidth}*${media.videoHeight}px`,
              sourcePath: detailsPath,
            });
            return;
          }

          resolve({
            summary: formatDuration(media.duration),
            sourcePath: detailsPath,
          });
        };
        media.onerror = () =>
          resolve({
            summary: formatBytes(asset.fileSize),
            sourcePath: detailsPath,
          });
        media.src = assetUrl;
      });

      if (!disposed) {
        setAssetDetails((previous) => ({
          ...previous,
          [asset.id]: nextDetails,
        }));
      }
    }

    void Promise.all(
      assets
        .filter((asset) => {
          const expectedPath =
            asset.status === "ready" && asset.workingPath
              ? asset.workingPath
              : asset.filePath;
          return assetDetails[asset.id]?.sourcePath !== expectedPath;
        })
        .map((asset) => loadDetails(asset)),
    );

    return () => {
      disposed = true;
    };
  }, [assetDetails, assets, getAssetUrl]);

  const assetsCountLabel = useMemo(
    () =>
      `${assets.length} item${assets.length === 1 ? "" : "s"} in project library`,
    [assets.length],
  );

  useEffect(() => {
    void loadAssets();
  }, [loadAssets]);

  // Poll for asset status updates while any asset is processing
  useEffect(() => {
    const hasProcessingAssets = assets.some(
      (asset) => asset.status === "processing" || asset.locked,
    );
    if (!hasProcessingAssets || !projectId) {
      return;
    }

    // Poll every 2 seconds while processing
    const pollInterval = setInterval(() => {
      void loadAssets();
    }, 2000);

    return () => clearInterval(pollInterval);
  }, [assets, projectId, loadAssets]);

  useEffect(() => {
    setAssetDetails({});
  }, [projectId]);

  return (
    <div className="flex h-full w-full flex-col border-r border-border bg-background">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 shrink-0">
        <Film className="h-4 w-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">Assets</div>
          <div className="truncate text-[11px] text-muted-foreground">
            {assetsCountLabel}
          </div>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => void loadAssets()}
                disabled={loading || importing || !projectId}
              >
                {loading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>Refresh assets</TooltipContent>
        </Tooltip>
        <Button
          variant="secondary"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={() => void handleImport()}
          disabled={importing || loading || !projectId}
        >
          {importing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Import className="h-3.5 w-3.5" />
          )}
          Import
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={() => setIsMyAssetsOpen(true)}
          disabled={importing || loading || !projectId}
        >
          <FolderHeart className="h-3.5 w-3.5" />
          My Assets
        </Button>
      </div>

      <div className="border-b border-border px-3 py-2 text-[11px] text-muted-foreground shrink-0">
        {projectPath ? `${projectPath}\assets` : "Project-local media library"}
      </div>

      {error ? (
        <div className="border-b border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive shrink-0">
          {error}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto">
        {assets.length === 0 && !loading ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs text-muted-foreground">
            <Film className="h-8 w-8 opacity-50" />
            <div>No project media yet</div>
            <div>
              Import image, video, or audio files into this Composer project.
            </div>
          </div>
        ) : (
          <div className="flex flex-col p-2">
            {assets.map((asset) => {
              const Icon = getAssetIcon(asset.type);
              const details = assetDetails[asset.id];
              const isReady = asset.status === "ready" || !asset.status;
              const isLocked = asset.locked;
              const isInteractive = isReady && !isLocked;
              const progressViewModel = getAssetProgressViewModel(asset);

              return (
                <div
                  key={asset.id}
                  draggable={isInteractive}
                  onDragStart={(event) => {
                    if (isInteractive) {
                      handleDragStart(event, asset);
                    } else {
                      event.preventDefault();
                    }
                  }}
                  onDoubleClick={() => {
                    if (isInteractive) {
                      previewLibraryAsset(asset);
                    }
                  }}
                  className={cn(
                    "flex items-center gap-3 rounded-md border border-transparent px-2 py-2 transition-colors",
                    isInteractive
                      ? "cursor-grab hover:border-border hover:bg-muted/40 active:cursor-grabbing"
                      : "cursor-not-allowed opacity-70",
                    isLocked && "border-amber-500/20 bg-amber-500/[0.03]",
                  )}
                >
                  {details?.thumbnailUrl ? (
                    <div className="relative h-9 w-12 shrink-0 overflow-hidden rounded-md border border-border bg-muted">
                      <img
                        src={details.thumbnailUrl}
                        alt={asset.fileName}
                        className={cn(
                          "h-full w-full object-cover",
                          isLocked && "opacity-70",
                        )}
                        draggable={false}
                      />
                      {isLocked ? (
                        <div
                          className="absolute inset-0 bg-background/20"
                          aria-hidden="true"
                        />
                      ) : null}
                      {isLocked ? (
                        <div className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-amber-500 text-white shadow-sm">
                          <Lock className="h-2.5 w-2.5" />
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div
                      className={cn(
                        "relative flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground",
                        isLocked &&
                          "bg-amber-500/10 text-amber-700 dark:text-amber-400",
                      )}
                    >
                      {asset.status === "processing" ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : asset.status === "error" ? (
                        <span className="text-destructive">!</span>
                      ) : (
                        <Icon className="h-4 w-4" />
                      )}
                      {isLocked ? (
                        <div className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-amber-500 text-white shadow-sm">
                          <Lock className="h-2.5 w-2.5" />
                        </div>
                      ) : null}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">
                      {asset.fileName}
                    </div>
                    <div className="flex flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
                        <span className="normal-case">
                          {details?.summary ?? formatBytes(asset.fileSize)}
                        </span>
                        {asset.hasUnsupportedAudio && (
                          <span className="text-amber-600 dark:text-amber-500">
                            audio-unsupported
                          </span>
                        )}
                        {isLocked && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-amber-700 dark:text-amber-400">
                            <Lock className="h-2.5 w-2.5" />
                            Locked
                          </span>
                        )}
                      </div>
                      {progressViewModel && asset.status !== "error" && (
                        <div className="space-y-1 rounded-sm border border-border/60 bg-muted/20 px-2 py-1.5">
                          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                            <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                            <span className="truncate">
                              {progressViewModel.label}
                            </span>
                            <span className="ml-auto shrink-0 font-medium text-foreground/80">
                              {Math.round(progressViewModel.progress)}%
                            </span>
                          </div>
                          <Progress
                            value={progressViewModel.progress}
                            className="h-1.5"
                          />
                          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                            <span className="truncate">
                              {progressViewModel.detail}
                            </span>
                            <span className="ml-auto shrink-0 rounded-full border border-border px-1.5 py-0.5 uppercase tracking-wide text-[9px]">
                              {progressViewModel.stageTag}
                            </span>
                          </div>
                          {progressViewModel.stageValue > 0 &&
                          progressViewModel.stageValue !==
                            progressViewModel.progress ? (
                            <div className="text-[10px] text-muted-foreground/80">
                              Current stage{" "}
                              {Math.round(progressViewModel.stageValue)}%
                            </div>
                          ) : null}
                        </div>
                      )}
                      {asset.status === "processing" && !progressViewModel && (
                        <div className="text-[10px] text-muted-foreground">
                          {asset.statusMessage ?? "Importing asset..."}
                        </div>
                      )}
                      {asset.status === "error" && asset.statusMessage && (
                        <div className="text-[10px] text-destructive">
                          {asset.statusMessage}
                        </div>
                      )}
                    </div>
                  </div>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                        onClick={(event) => {
                          event.stopPropagation();
                          const linkedClips = projectClips.filter(
                            (clip) => clip.sourceAssetId === asset.id,
                          );
                          if (
                            linkedClips.length > 0 &&
                            !window.confirm(
                              "This action cannot be undone. All instances of this asset will be removed. Proceed?",
                            )
                          ) {
                            return;
                          }

                          void (async () => {
                            try {
                              previewLibraryAsset(null);
                              if (linkedClips.length > 0) {
                                await Promise.all(
                                  linkedClips.map((clip) =>
                                    composerClipIpc.delete({
                                      projectId: projectId!,
                                      clipId: clip.id,
                                    }),
                                  ),
                                );
                                setClips(
                                  projectClips.filter(
                                    (clip) => clip.sourceAssetId !== asset.id,
                                  ),
                                );
                              }

                              const nextAssets = await composerAssetIpc.delete({
                                projectId: projectId!,
                                assetId: asset.id,
                              });
                              setAssets(nextAssets);
                              setAssetDetails((previous) => {
                                const next = { ...previous };
                                delete next[asset.id];
                                return next;
                              });
                              previewLibraryAsset(null);
                            } catch (err) {
                              setError(
                                (err as Error).message ??
                                  "Failed to delete asset",
                              );
                            }
                          })();
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Delete asset from project</TooltipContent>
                  </Tooltip>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <MyAssetsPickerDialog
        open={isMyAssetsOpen}
        onOpenChange={setIsMyAssetsOpen}
        onImport={handleImportFromMyAssets}
        importing={importing}
      />
    </div>
  );
}
