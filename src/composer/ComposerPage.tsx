import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Copy,
  Eye,
  EyeOff,
  ExternalLink,
  Film,
  FolderOpen,
  Loader2,
  MoreVertical,
  Plus,
  Search,
  Star,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import { ComposerEditor } from "@/composer/editor/ComposerEditor";
import type { ComposerProjectSummary } from "@/composer/types/project";
import { useComposerProjectStore } from "@/composer/stores/project.store";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { composerProjectIpc } from "@/composer/ipc/ipc-client";

const FFMPEG_REQUIRED_MESSAGE = "FFmpeg is required";
const WINDOWS_FFMPEG_INSTALL_URL = "https://www.gyan.dev/ffmpeg/builds/";

type ProjectSortOption = "newest" | "oldest" | "name-asc" | "name-desc";

function isFfmpegRequiredError(error: unknown): boolean {
  return error instanceof Error && error.message === FFMPEG_REQUIRED_MESSAGE;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatProjectTimestamp(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getPreviewUrl(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  return `local-asset://${encodeURIComponent(filePath)}`;
}

function ProjectPreviewMedia({
  project,
  showPreviews,
}: {
  project: ComposerProjectSummary;
  showPreviews: boolean;
}) {
  const previewUrl = getPreviewUrl(project.previewPath);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    setHasError(false);
  }, [previewUrl, project.id]);

  useEffect(() => {
    if (!showPreviews && videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
    }
  }, [showPreviews]);

  if (!showPreviews || !previewUrl || hasError) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-gradient-to-br from-muted to-muted/60 text-muted-foreground">
        <Film className="h-10 w-10" />
        <span className="text-xs">
          {!showPreviews ? "Preview hidden" : "No preview available"}
        </span>
      </div>
    );
  }

  const handleMouseEnter = () => {
    if (!videoRef.current) return;
    void videoRef.current.play().catch(() => undefined);
  };

  const handleMouseLeave = () => {
    if (!videoRef.current) return;
    videoRef.current.pause();
    videoRef.current.currentTime = 0;
  };

  return (
    <div
      className="h-full w-full overflow-hidden bg-black"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <video
        ref={videoRef}
        src={previewUrl}
        className="h-full w-full object-cover"
        muted
        loop
        playsInline
        preload="auto"
        onLoadedData={() => {
          if (!videoRef.current) return;
          videoRef.current.pause();
          videoRef.current.currentTime = 0;
        }}
        onError={() => setHasError(true)}
      />
    </div>
  );
}

export function ComposerPage() {
  const { t } = useTranslation();
  const location = useLocation();

  const {
    projectList,
    currentProject,
    loading,
    error,
    loadProjectList,
    createProject,
    openProject,
    setProjectFavorite,
    deleteProject,
    clearError,
  } = useComposerProjectStore();

  const [showNewDialog, setShowNewDialog] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [creating, setCreating] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<ProjectSortOption>("newest");
  const [showPreviews, setShowPreviews] = useState(true);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [checkingFfmpeg, setCheckingFfmpeg] = useState(true);
  const [ffmpegBlockedReason, setFfmpegBlockedReason] = useState<string | null>(
    null,
  );

  const runFfmpegCheck = useCallback(
    async (loadProjects: boolean) => {
      setCheckingFfmpeg(true);
      clearError();

      try {
        const status = await composerProjectIpc.checkFfmpeg();
        const blockedReason = status.available
          ? null
          : (status.blockedReason ?? FFMPEG_REQUIRED_MESSAGE);

        setFfmpegBlockedReason(blockedReason);

        if (status.available && loadProjects) {
          await loadProjectList();
        }
      } catch (error) {
        setFfmpegBlockedReason(
          (error as Error).message ?? FFMPEG_REQUIRED_MESSAGE,
        );
      } finally {
        setCheckingFfmpeg(false);
      }
    },
    [clearError, loadProjectList],
  );

  useEffect(() => {
    if (location.pathname !== "/composer") return;
    void runFfmpegCheck(true);
  }, [location.pathname, runFfmpegCheck]);

  async function handleInstallFfmpeg() {
    if (window.electronAPI?.openExternal) {
      await window.electronAPI.openExternal(WINDOWS_FFMPEG_INSTALL_URL);
      return;
    }

    window.open(WINDOWS_FFMPEG_INSTALL_URL, "_blank", "noopener,noreferrer");
  }

  async function handleCreate() {
    if (!newProjectName.trim()) return;
    setCreating(true);

    try {
      await createProject(newProjectName.trim());
      setShowNewDialog(false);
      setNewProjectName("");
    } catch (error) {
      if (isFfmpegRequiredError(error)) {
        setShowNewDialog(false);
        setNewProjectName("");
        await runFfmpegCheck(true);
      }
    } finally {
      setCreating(false);
    }
  }

  async function handleOpen(project: ComposerProjectSummary) {
    try {
      await openProject(project.id);
    } catch (error) {
      if (isFfmpegRequiredError(error)) {
        await runFfmpegCheck(true);
      }
    }
  }

  async function handleDeleteProject(project: ComposerProjectSummary) {
    if (!confirm(`Delete project "${project.name}"? This cannot be undone.`)) {
      return;
    }

    await deleteProject(project.id);
  }

  async function handleToggleFavorite(project: ComposerProjectSummary) {
    await setProjectFavorite(project.id, !(project.favorite ?? false));
  }

  async function handleOpenProjectLocation(project: ComposerProjectSummary) {
    await composerProjectIpc.openLocation({ id: project.id });
  }

  async function handleDuplicateProject(project: ComposerProjectSummary) {
    await composerProjectIpc.duplicate({ id: project.id });
    await loadProjectList();
  }

  const totalSizeOnDisk = useMemo(
    () =>
      projectList.reduce(
        (sum, project) => sum + (project.sizeOnDiskBytes ?? 0),
        0,
      ),
    [projectList],
  );

  const visibleProjects = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    const filtered = projectList.filter((project) => {
      if (favoritesOnly && !project.favorite) {
        return false;
      }

      if (!query) {
        return true;
      }

      return (
        project.name.toLowerCase().includes(query) ||
        project.path.toLowerCase().includes(query)
      );
    });

    return [...filtered].sort((left, right) => {
      switch (sortBy) {
        case "oldest":
          return (
            new Date(left.updatedAt).getTime() -
            new Date(right.updatedAt).getTime()
          );
        case "name-asc":
          return left.name.localeCompare(right.name);
        case "name-desc":
          return right.name.localeCompare(left.name);
        case "newest":
        default:
          return (
            new Date(right.updatedAt).getTime() -
            new Date(left.updatedAt).getTime()
          );
      }
    });
  }, [favoritesOnly, projectList, searchQuery, sortBy]);
  const projectGridClassName =
    "grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5";

  if (checkingFfmpeg) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (ffmpegBlockedReason) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Card className="w-full max-w-lg">
          <CardHeader className="text-center">
            <AlertTriangle className="mx-auto h-12 w-12 text-amber-500" />
            <CardTitle>{FFMPEG_REQUIRED_MESSAGE}</CardTitle>
            <CardDescription>{ffmpegBlockedReason}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 sm:flex-row sm:justify-center">
            <Button
              onClick={() => void runFfmpegCheck(true)}
              disabled={checkingFfmpeg}
            >
              {checkingFfmpeg ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Recheck
            </Button>
            <Button
              variant="outline"
              onClick={() => void handleInstallFfmpeg()}
            >
              <ExternalLink className="mr-2 h-4 w-4" />
              Install FFmpeg for Windows
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (currentProject) {
    return <ComposerEditor project={currentProject} />;
  }

  return (
    <div className="flex h-full flex-col pt-12 md:pt-0">
      <div className="border-b border-border/70 px-4 py-4 shrink-0 animate-in fade-in slide-in-from-bottom-2 duration-300 fill-mode-both md:px-6">
        <div className="mb-4 flex flex-col gap-2 md:flex-row md:items-baseline md:justify-between">
          <div className="flex flex-col gap-1.5 md:flex-row md:items-baseline md:gap-3">
            <h1 className="flex items-center gap-3 text-xl font-bold tracking-tight md:text-2xl">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Film className="h-5 w-5" />
              </span>
              {t("nav.composer")}
            </h1>
            <p className="text-xs text-muted-foreground md:text-sm">
              {projectList.length} saved project
              {projectList.length === 1 ? "" : "s"} •{" "}
              {formatBytes(totalSizeOnDisk)} on disk
            </p>
          </div>
          <Button size="sm" onClick={() => setShowNewDialog(true)}>
            <Plus className="mr-1 h-4 w-4" />
            New project
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full max-w-sm">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search projects"
              className="pl-9"
            />
          </div>
          <Select
            value={sortBy}
            onValueChange={(value) => setSortBy(value as ProjectSortOption)}
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Sort projects" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest first</SelectItem>
              <SelectItem value="oldest">Oldest first</SelectItem>
              <SelectItem value="name-asc">Name A-Z</SelectItem>
              <SelectItem value="name-desc">Name Z-A</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant={showPreviews ? "default" : "outline"}
            size="icon"
            className="shrink-0"
            onClick={() => setShowPreviews((value) => !value)}
            title={showPreviews ? "Hide previews" : "Show previews"}
          >
            {showPreviews ? (
              <Eye className="h-4 w-4" />
            ) : (
              <EyeOff className="h-4 w-4" />
            )}
          </Button>
          <Button
            variant={favoritesOnly ? "default" : "outline"}
            size="icon"
            className="shrink-0"
            onClick={() => setFavoritesOnly((value) => !value)}
            title={favoritesOnly ? "Show all projects" : "Show favorites only"}
          >
            <Star className={cn("h-4 w-4", favoritesOnly && "fill-current")} />
          </Button>
        </div>
      </div>

      {error && (
        <div className="mx-4 mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive flex items-center justify-between">
          {error}
          <button onClick={clearError} className="ml-2 text-xs underline">
            Dismiss
          </button>
        </div>
      )}

      <div
        className="flex-1 overflow-y-auto px-4 py-4 animate-in fade-in duration-300 fill-mode-both md:px-6"
        style={{ animationDelay: "100ms" }}
      >
        {loading && projectList.length === 0 ? (
          <div className="flex items-center justify-center h-40 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            Loading projects…
          </div>
        ) : projectList.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-muted-foreground gap-3">
            <FolderOpen className="h-10 w-10 opacity-30" />
            <p>No projects yet</p>
            <Button size="sm" onClick={() => setShowNewDialog(true)}>
              <Plus className="h-4 w-4 mr-1" />
              Create your first project
            </Button>
          </div>
        ) : visibleProjects.length === 0 ? (
          <div className="flex h-48 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
            <Search className="h-10 w-10 opacity-30" />
            <div>No projects match the current filters.</div>
            <div className="text-sm">
              Try a different search, sort, or favorite filter.
            </div>
          </div>
        ) : (
          <div className={projectGridClassName}>
            {visibleProjects.map((project, index) => (
              <Card
                key={project.id}
                role="button"
                tabIndex={0}
                className="group overflow-hidden border-border/70 bg-card/85 p-0 text-left shadow-sm transition-all hover:border-primary/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                style={{ animationDelay: `${Math.min(index, 19) * 30}ms` }}
                onClick={() => void handleOpen(project)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    void handleOpen(project);
                  }
                }}
              >
                <div className="relative aspect-square border-b border-border/60 bg-muted">
                  <ProjectPreviewMedia
                    project={project}
                    showPreviews={showPreviews}
                  />
                  <button
                    type="button"
                    className={cn(
                      "absolute right-2 top-2 z-10 flex h-8 w-8 items-center justify-center rounded-md backdrop-blur-sm transition-colors",
                      project.favorite
                        ? "bg-yellow-500/85 text-white hover:bg-yellow-500"
                        : "bg-black/60 text-white hover:bg-black/80",
                    )}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleToggleFavorite(project);
                    }}
                    aria-label={
                      project.favorite
                        ? "Remove project from favorites"
                        : "Add project to favorites"
                    }
                  >
                    <Star
                      className={cn(
                        "h-4 w-4",
                        project.favorite && "fill-current",
                      )}
                    />
                  </button>
                </div>

                <CardContent className="p-4">
                  <div className="mb-3 flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div
                        className="truncate text-base font-semibold"
                        title={project.name}
                      >
                        {project.name}
                      </div>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <DropdownMenuItem
                            onSelect={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              void handleOpenProjectLocation(project);
                            }}
                          >
                            <FolderOpen className="mr-2 h-4 w-4" />
                            Project location
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              void handleToggleFavorite(project);
                            }}
                          >
                            <Star className="mr-2 h-4 w-4" />
                            {project.favorite
                              ? "Remove from Favorites"
                              : "Add to Favorites"}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              void handleDuplicateProject(project);
                            }}
                          >
                            <Copy className="mr-2 h-4 w-4" />
                            Duplicate
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onSelect={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              void handleDeleteProject(project);
                            }}
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                  </div>

                  <div className="space-y-1 text-sm text-muted-foreground">
                    <div>
                      Last edited {formatProjectTimestamp(project.updatedAt)}
                    </div>
                    <div>
                      {formatBytes(project.sizeOnDiskBytes ?? 0)} on disk
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Dialog open={showNewDialog} onOpenChange={setShowNewDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Composer project</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <Input
              placeholder="Project name"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void handleCreate()}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setShowNewDialog(false);
                setNewProjectName("");
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void handleCreate()}
              disabled={!newProjectName.trim() || creating}
            >
              {creating ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1" />
              ) : (
                <Plus className="h-4 w-4 mr-1" />
              )}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
