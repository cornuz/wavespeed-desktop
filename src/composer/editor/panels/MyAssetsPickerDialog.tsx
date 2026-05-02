import { useEffect, useMemo, useRef, useState } from "react";
import {
  FolderHeart,
  Image as ImageIcon,
  Loader2,
  Music,
  Search,
  Star,
  Video,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useAssetsStore } from "@/stores/assetsStore";
import type { AssetMetadata } from "@/types/asset";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function getAssetUrl(asset: AssetMetadata): string {
  if (asset.filePath) {
    return `local-asset://${encodeURIComponent(asset.filePath)}`;
  }
  return asset.originalUrl || "";
}

function VideoCardPreview({ src, alt }: { src: string; alt: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [hasError, setHasError] = useState(false);

  const handleMouseEnter = () => {
    if (!videoRef.current || hasError) return;
    void videoRef.current.play().catch(() => undefined);
  };

  const handleMouseLeave = () => {
    if (!videoRef.current) return;
    videoRef.current.pause();
    videoRef.current.currentTime = 0;
  };

  if (!src || hasError) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-muted">
        <Video className="h-10 w-10 text-muted-foreground" />
      </div>
    );
  }

  return (
    <div
      className="h-full w-full bg-black/5"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <video
        ref={videoRef}
        src={src}
        className="h-full w-full object-cover"
        muted
        loop
        playsInline
        preload="auto"
        aria-label={alt}
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

function AssetTypeIcon({ type }: { type: AssetMetadata["type"] }) {
  switch (type) {
    case "image":
      return <ImageIcon className="h-4 w-4" />;
    case "video":
      return <Video className="h-4 w-4" />;
    case "audio":
      return <Music className="h-4 w-4" />;
    default:
      return <ImageIcon className="h-4 w-4" />;
  }
}

interface MyAssetsPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: (filePaths: string[]) => Promise<void>;
  importing?: boolean;
}

export function MyAssetsPickerDialog({
  open,
  onOpenChange,
  onImport,
  importing = false,
}: MyAssetsPickerDialogProps) {
  const assets = useAssetsStore((state) => state.assets);
  const isLoaded = useAssetsStore((state) => state.isLoaded);
  const isLoading = useAssetsStore((state) => state.isLoading);
  const loadAssets = useAssetsStore((state) => state.loadAssets);

  const [searchQuery, setSearchQuery] = useState("");
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    void loadAssets();
  }, [loadAssets, open]);

  useEffect(() => {
    if (open) return;
    setSearchQuery("");
    setSelectedPaths(new Set());
  }, [open]);

  const visibleAssets = useMemo(
    () =>
      assets.filter((asset) => {
        if (!asset.filePath) return false;
        if (
          asset.type !== "image" &&
          asset.type !== "video" &&
          asset.type !== "audio"
        ) {
          return false;
        }

        const query = searchQuery.trim().toLowerCase();
        if (!query) return true;
        return (
          asset.fileName.toLowerCase().includes(query) ||
          asset.modelId.toLowerCase().includes(query) ||
          asset.tags.some((tag) => tag.toLowerCase().includes(query))
        );
      }),
    [assets, searchQuery],
  );

  const selectedCount = selectedPaths.size;

  const toggleSelectedPath = (filePath: string) => {
    setSelectedPaths((previous) => {
      const next = new Set(previous);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
  };

  const handleImport = async () => {
    if (selectedPaths.size === 0) return;
    await onImport([...selectedPaths]);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-6xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border/70 px-6 py-5">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <FolderHeart className="h-5 w-5 text-primary" />
            My Assets
          </DialogTitle>
          <DialogDescription>
            Import media from your WaveSpeed library into this Composer project.
          </DialogDescription>
          <div className="relative mt-3 w-full max-w-sm">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search My Assets"
              className="pl-9"
            />
          </div>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col">
          {isLoading && !isLoaded ? (
            <div className="flex h-72 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading My Assets…
            </div>
          ) : visibleAssets.length === 0 ? (
            <div className="flex h-72 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
              <FolderHeart className="h-10 w-10 opacity-40" />
              <div>No matching assets found.</div>
              <div>
                Save media to My Assets first, then import it into this project.
              </div>
            </div>
          ) : (
            <ScrollArea className="min-h-0 flex-1">
              <div className="grid grid-cols-2 gap-4 p-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {visibleAssets.map((asset) => {
                  const assetUrl = getAssetUrl(asset);
                  const selected = selectedPaths.has(asset.filePath);

                  return (
                    <div
                      key={asset.id}
                      role="button"
                      tabIndex={0}
                      aria-pressed={selected}
                      className={cn(
                        "group relative overflow-hidden rounded-xl border border-border/70 bg-card/85 text-left shadow-sm transition-all hover:border-primary/40 hover:shadow-md",
                        selected && "ring-2 ring-primary",
                      )}
                      onClick={() => toggleSelectedPath(asset.filePath)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          toggleSelectedPath(asset.filePath);
                        }
                      }}
                    >
                      <div className="relative aspect-square overflow-hidden bg-muted">
                        {asset.type === "image" && assetUrl ? (
                          <img
                            src={assetUrl}
                            alt={asset.fileName}
                            className="h-full w-full object-cover"
                            loading="lazy"
                          />
                        ) : asset.type === "video" && assetUrl ? (
                          <VideoCardPreview
                            src={assetUrl}
                            alt={asset.fileName}
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center">
                            <AssetTypeIcon type={asset.type} />
                          </div>
                        )}

                        <div
                          className="absolute left-2 top-2"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <Checkbox
                            checked={selected}
                            onCheckedChange={() =>
                              toggleSelectedPath(asset.filePath)
                            }
                            className="bg-background/95"
                          />
                        </div>

                        <Badge
                          variant="secondary"
                          className="absolute bottom-2 left-2 text-[10px]"
                        >
                          <AssetTypeIcon type={asset.type} />
                          <span className="ml-1 capitalize">{asset.type}</span>
                        </Badge>

                        {asset.favorite ? (
                          <div className="absolute right-2 top-2 rounded-md bg-black/70 p-1 text-white">
                            <Star className="h-3 w-3 fill-current" />
                          </div>
                        ) : null}
                      </div>

                      <div className="space-y-1 p-3">
                        <div
                          className="truncate text-sm font-medium"
                          title={asset.fileName}
                        >
                          {asset.fileName}
                        </div>
                        <div
                          className="truncate text-xs text-muted-foreground"
                          title={asset.modelId}
                        >
                          {asset.modelId}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {formatBytes(asset.fileSize)}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          )}
        </div>

        <DialogFooter className="border-t border-border/70 px-6 py-4">
          <div className="mr-auto text-sm text-muted-foreground">
            {selectedCount} selected
          </div>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={importing}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void handleImport()}
            disabled={selectedCount === 0 || importing}
          >
            {importing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}
            Import selected
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
