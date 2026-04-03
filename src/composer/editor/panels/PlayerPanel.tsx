import { Play } from "lucide-react";

export function PlayerPanel() {
  return (
    <div className="flex flex-col h-full w-full bg-black">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
        <Play className="w-4 h-4 text-muted-foreground" />
        <span className="text-sm font-medium text-muted-foreground">Player</span>
      </div>
      <div className="flex-1 flex items-center justify-center text-muted-foreground/40 text-xs">
        Video preview — coming soon
      </div>
    </div>
  );
}
