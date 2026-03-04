/**
 * Flow graph canvas — Detroit: Become Human style storyboard visualization.
 * Renders shots as connected nodes with act separators.
 */
import { useRef, useState, useCallback } from "react";
import { useStoryboardStore } from "../stores/storyboard.store";
import { ShotNode } from "./ShotNode";
import { cn } from "@/lib/utils";

const TRANSITION_LABELS: Record<string, string> = {
  cut: "硬切",
  fade: "淡入淡出",
  dissolve: "溶解",
  wipe: "擦除",
  match_cut: "匹配剪辑",
};

export function FlowCanvas() {
  const shots = useStoryboardStore((s) => s.shots);
  const characters = useStoryboardStore((s) => s.characters);
  const scenes = useStoryboardStore((s) => s.scenes);
  const edges = useStoryboardStore((s) => s.edges);
  const selectedShotId = useStoryboardStore((s) => s.selectedShotId);
  const selectShot = useStoryboardStore((s) => s.selectShot);
  const regenerateShot = useStoryboardStore((s) => s.regenerateShot);

  const canvasRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0 });

  const sorted = [...shots].sort(
    (a, b) => a.sequence_number - b.sequence_number,
  );

  // Group by act
  const acts = new Map<number, typeof sorted>();
  sorted.forEach((shot) => {
    const arr = acts.get(shot.act_number) || [];
    arr.push(shot);
    acts.set(shot.act_number, arr);
  });

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.05 : 0.05;
    setScale((s) => Math.max(0.3, Math.min(2, s + delta)));
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      setIsPanning(true);
      panStart.current = { x: e.clientX - offset.x, y: e.clientY - offset.y };
    }
  }, [offset]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isPanning) return;
      setOffset({
        x: e.clientX - panStart.current.x,
        y: e.clientY - panStart.current.y,
      });
    },
    [isPanning],
  );

  const handleMouseUp = useCallback(() => setIsPanning(false), []);

  if (sorted.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground/50">
        <div className="text-center space-y-2">
          <div className="text-4xl">🎬</div>
          <p className="text-sm">在下方输入你的故事想法，开始创作</p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={canvasRef}
      className="flex-1 overflow-hidden relative bg-gradient-to-br from-background via-background to-muted/10 cursor-grab active:cursor-grabbing"
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      {/* Zoom controls */}
      <div className="absolute top-3 right-3 z-10 flex items-center gap-1 bg-background/80 backdrop-blur rounded-lg border px-2 py-1">
        <button
          onClick={() => setScale((s) => Math.max(0.3, s - 0.1))}
          className="text-xs px-1 hover:text-foreground text-muted-foreground"
        >
          −
        </button>
        <span className="text-[10px] text-muted-foreground w-10 text-center">
          {Math.round(scale * 100)}%
        </span>
        <button
          onClick={() => setScale((s) => Math.min(2, s + 0.1))}
          className="text-xs px-1 hover:text-foreground text-muted-foreground"
        >
          +
        </button>
      </div>

      {/* Canvas content */}
      <div
        className="absolute inset-0 p-8"
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          transformOrigin: "0 0",
        }}
      >
        {Array.from(acts.entries()).map(([actNum, actShots]) => (
          <div key={actNum} className="mb-8">
            {/* Act separator */}
            <div className="flex items-center gap-3 mb-4">
              <div className="h-px flex-1 bg-gradient-to-r from-transparent via-primary/30 to-transparent" />
              <span className="text-xs font-semibold text-primary/70 uppercase tracking-wider">
                第 {actNum} 幕
              </span>
              <div className="h-px flex-1 bg-gradient-to-r from-transparent via-primary/30 to-transparent" />
            </div>

            {/* Shot nodes in a flow */}
            <div className="flex flex-wrap gap-4 items-start">
              {actShots.map((shot, idx) => {
                const scene = scenes.find((s) => s.scene_id === shot.scene_id);
                const isFrameChain =
                  idx > 0 &&
                  edges.some(
                    (e) =>
                      e.from === actShots[idx - 1].shot_id &&
                      e.to === shot.shot_id &&
                      e.type === "frame_chain",
                  );

                return (
                  <div key={shot.shot_id} className="flex items-center gap-1">
                    {/* Connection line */}
                    {idx > 0 && (
                      <div className="flex flex-col items-center mx-1">
                        <div
                          className={cn(
                            "w-8 h-0.5",
                            isFrameChain
                              ? "bg-primary/40"
                              : "bg-muted-foreground/20 border-dashed border-t",
                          )}
                        />
                        <span className="text-[8px] text-muted-foreground/40 mt-0.5">
                          {TRANSITION_LABELS[actShots[idx - 1].transition_to_next] || "切"}
                        </span>
                      </div>
                    )}
                    <ShotNode
                      shot={shot}
                      characters={characters}
                      scene={scene}
                      isSelected={selectedShotId === shot.shot_id}
                      onClick={() => selectShot(shot.shot_id)}
                      onPreview={() => {}}
                      onRegenerate={() => regenerateShot(shot.shot_id)}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
