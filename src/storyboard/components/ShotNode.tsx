/**
 * Shot node card for the flow graph — Detroit: Become Human style.
 */
import { cn } from "@/lib/utils";
import type { Shot, Character, Scene } from "../types";
import {
  Camera,
  Clock,
  Play,
  RefreshCw,
  Star,
  AlertTriangle,
  Users,
} from "lucide-react";

interface ShotNodeProps {
  shot: Shot;
  characters: Character[];
  scene: Scene | undefined;
  isSelected: boolean;
  onClick: () => void;
  onPreview: () => void;
  onRegenerate: () => void;
}

const statusColors: Record<string, string> = {
  pending: "border-muted-foreground/30 bg-card/50",
  generating: "border-blue-500 bg-blue-500/5 animate-pulse",
  done: "border-green-500/50 bg-card",
  failed: "border-red-500/50 bg-red-500/5",
  dirty: "border-yellow-500/50 bg-yellow-500/5",
};

const statusDots: Record<string, string> = {
  pending: "bg-muted-foreground/40",
  generating: "bg-blue-500 animate-ping",
  done: "bg-green-500",
  failed: "bg-red-500",
  dirty: "bg-yellow-500",
};

const shotTypeLabels: Record<string, string> = {
  wide: "全景",
  medium: "中景",
  close_up: "特写",
  extreme_close_up: "大特写",
  over_shoulder: "过肩",
  pov: "主观",
  aerial: "俯拍",
};

export function ShotNode({
  shot,
  characters,
  isSelected,
  onClick,
  onPreview,
  onRegenerate,
}: ShotNodeProps) {
  const shotChars = characters.filter((c) =>
    shot.character_ids.includes(c.character_id),
  );

  return (
    <div
      onClick={onClick}
      className={cn(
        "relative w-56 rounded-xl border-2 p-3 cursor-pointer transition-all duration-300 hover:shadow-lg hover:scale-[1.02] group",
        statusColors[shot.generation_status],
        isSelected && "ring-2 ring-primary shadow-xl scale-[1.03]",
      )}
    >
      {/* Thumbnail area */}
      <div className="relative w-full h-28 rounded-lg bg-muted/30 mb-2 overflow-hidden flex items-center justify-center">
        {shot.generated_assets.thumbnail ? (
          <img
            src={shot.generated_assets.thumbnail}
            alt={`Shot ${shot.sequence_number}`}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="text-center text-muted-foreground/50 text-xs px-2">
            <Camera className="h-6 w-6 mx-auto mb-1 opacity-30" />
            {shot.action_description.slice(0, 40)}...
          </div>
        )}

        {/* Key shot badge */}
        {shot.is_key_shot && (
          <div className="absolute top-1 right-1 bg-yellow-500/90 rounded-full p-0.5">
            <Star className="h-3 w-3 text-white" />
          </div>
        )}

        {/* QC warning */}
        {shot.qc_warnings.length > 0 && (
          <div className="absolute top-1 left-1 bg-orange-500/90 rounded-full p-0.5">
            <AlertTriangle className="h-3 w-3 text-white" />
          </div>
        )}
      </div>

      {/* Shot info */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-foreground">
            Shot #{shot.sequence_number}
          </span>
          <div className="flex items-center gap-1">
            <span className={cn("h-2 w-2 rounded-full", statusDots[shot.generation_status])} />
          </div>
        </div>

        <p className="text-[11px] text-muted-foreground line-clamp-2 leading-tight">
          {shot.action_description}
        </p>

        {/* Characters */}
        {shotChars.length > 0 && (
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground/70">
            <Users className="h-3 w-3" />
            {shotChars.map((c) => c.name).join(", ")}
          </div>
        )}

        {/* Meta row */}
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground/60">
          <span className="flex items-center gap-0.5">
            <Clock className="h-3 w-3" />
            {shot.duration}s
          </span>
          <span>🎬 {shotTypeLabels[shot.shot_type] || shot.shot_type}</span>
          {shot.emotion_tag !== "neutral" && (
            <span className="text-[10px]">{shot.emotion_tag}</span>
          )}
        </div>
      </div>

      {/* Action buttons — visible on hover */}
      <div className="absolute bottom-1 right-1 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={(e) => { e.stopPropagation(); onPreview(); }}
          className="p-1 rounded bg-background/80 hover:bg-muted text-muted-foreground hover:text-foreground"
          title="预览"
        >
          <Play className="h-3 w-3" />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onRegenerate(); }}
          className="p-1 rounded bg-background/80 hover:bg-muted text-muted-foreground hover:text-foreground"
          title="重新生成"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
