import { Layers } from "lucide-react";

export function TimelinePanel() {
  return (
    <div className="flex flex-col h-full w-full bg-background border-t border-border">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
        <Layers className="w-4 h-4 text-muted-foreground" />
        <span className="text-sm font-medium text-muted-foreground">Timeline</span>
      </div>
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-xs">
        Track editor — coming soon
      </div>
    </div>
  );
}
