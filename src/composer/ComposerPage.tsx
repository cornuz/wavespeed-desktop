import { useEffect, useState } from "react";
import { Film, FolderOpen, Plus, Trash2, ChevronRight, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useComposerProjectStore } from "@/composer/stores/project.store";
import { ComposerEditor } from "@/composer/editor/ComposerEditor";
import type { ComposerProjectSummary } from "@/composer/types/project";

export function ComposerPage() {
  const { t } = useTranslation();

  const {
    projectList,
    currentProject,
    loading,
    error,
    loadProjectList,
    createProject,
    openProject,
    deleteProject,
    clearError,
  } = useComposerProjectStore();

  const [showNewDialog, setShowNewDialog] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [creating, setCreating] = useState(false);

  // Load project list on mount
  useEffect(() => {
    loadProjectList();
  }, [loadProjectList]);

  async function handleCreate() {
    if (!newProjectName.trim()) return;
    setCreating(true);
    try {
      await createProject(newProjectName.trim());
      setShowNewDialog(false);
      setNewProjectName("");
    } finally {
      setCreating(false);
    }
  }

  async function handleOpen(project: ComposerProjectSummary) {
    await openProject(project.id);
  }

  async function handleDelete(e: React.MouseEvent, project: ComposerProjectSummary) {
    e.stopPropagation();
    if (!confirm(`Delete project "${project.name}"? This cannot be undone.`)) return;
    await deleteProject(project.id);
  }

  // ── Project open — show editor ────────────────────────────────────────────
  if (currentProject) {
    return <ComposerEditor project={currentProject} />;
  }

  // ── Project selector ───────────────────────────────────────────────────────
  return (
    <div className="flex h-full flex-col pt-12 md:pt-0">
      {/* Header */}
      <div className="px-4 md:px-6 py-4 border-b border-border shrink-0 animate-in fade-in slide-in-from-bottom-2 duration-300 fill-mode-both flex items-center justify-between">
        <h1 className="text-xl md:text-2xl font-bold tracking-tight flex items-center gap-2">
          <Film className="h-5 w-5 text-primary" />
          {t("nav.composer")}
        </h1>
        <Button size="sm" onClick={() => setShowNewDialog(true)}>
          <Plus className="h-4 w-4 mr-1" />
          New project
        </Button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="mx-4 mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive flex items-center justify-between">
          {error}
          <button onClick={clearError} className="ml-2 text-xs underline">
            Dismiss
          </button>
        </div>
      )}

      {/* Project list */}
      <div
        className="flex-1 overflow-y-auto px-4 md:px-6 py-4 animate-in fade-in duration-300 fill-mode-both"
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
        ) : (
          <ul className="space-y-2">
            {[...projectList]
              .sort(
                (a, b) =>
                  new Date(b.lastOpenedAt).getTime() -
                  new Date(a.lastOpenedAt).getTime(),
              )
              .map((project) => (
                <li key={project.id}>
                  <button
                    className="w-full text-left rounded-lg border border-border bg-card hover:bg-accent transition-colors px-4 py-3 flex items-center gap-3 group"
                    onClick={() => handleOpen(project)}
                    disabled={loading}
                  >
                    <Film className="h-5 w-5 text-muted-foreground shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{project.name}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        Last opened:{" "}
                        {new Date(project.lastOpenedAt).toLocaleDateString()}
                      </p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                    <button
                      className="p-1 rounded opacity-0 group-hover:opacity-100 hover:text-destructive transition-all shrink-0"
                      onClick={(e) => handleDelete(e, project)}
                      aria-label="Delete project"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </button>
                </li>
              ))}
          </ul>
        )}
      </div>

      {/* New project dialog */}
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
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
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
              onClick={handleCreate}
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

