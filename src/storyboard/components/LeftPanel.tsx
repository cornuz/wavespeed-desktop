/**
 * Left panel — Character cards, Scene cards, Global style settings.
 */
import { useStoryboardStore } from "../stores/storyboard.store";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { User, MapPin, Palette, Volume2 } from "lucide-react";

export function LeftPanel() {
  const characters = useStoryboardStore((s) => s.characters);
  const scenes = useStoryboardStore((s) => s.scenes);
  const project = useStoryboardStore((s) => s.project);
  const selectedCharacterId = useStoryboardStore((s) => s.selectedCharacterId);
  const selectedSceneId = useStoryboardStore((s) => s.selectedSceneId);
  const selectCharacter = useStoryboardStore((s) => s.selectCharacter);
  const selectScene = useStoryboardStore((s) => s.selectScene);

  if (!project) return null;

  return (
    <div className="w-56 border-r bg-background/50 flex flex-col shrink-0">
      <ScrollArea className="flex-1">
        <div className="p-3 space-y-4">
          {/* Characters */}
          <section>
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 mb-2 flex items-center gap-1">
              <User className="h-3 w-3" /> 角色 ({characters.length})
            </h3>
            <div className="space-y-2">
              {characters.map((char) => (
                <div
                  key={char.character_id}
                  onClick={() => selectCharacter(char.character_id)}
                  className={cn(
                    "rounded-lg border p-2 cursor-pointer transition-all hover:shadow-sm",
                    selectedCharacterId === char.character_id
                      ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                      : "border-border/50 hover:border-border",
                  )}
                >
                  <div className="flex items-start gap-2">
                    {/* Avatar placeholder */}
                    <div className="w-10 h-10 rounded-lg bg-muted/50 flex items-center justify-center shrink-0 overflow-hidden">
                      {char.anchor_images.front ? (
                        <img src={char.anchor_images.front} alt={char.name} className="w-full h-full object-cover" />
                      ) : (
                        <User className="h-4 w-4 text-muted-foreground/40" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium truncate">{char.name}</p>
                      <p className="text-[10px] text-muted-foreground line-clamp-2 leading-tight">
                        {char.visual_description.slice(0, 60)}...
                      </p>
                      {char.voice_id && (
                        <span className="text-[9px] text-muted-foreground/60 flex items-center gap-0.5 mt-0.5">
                          <Volume2 className="h-2.5 w-2.5" /> {char.voice_id}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Scenes */}
          <section>
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 mb-2 flex items-center gap-1">
              <MapPin className="h-3 w-3" /> 场景 ({scenes.length})
            </h3>
            <div className="space-y-2">
              {scenes.map((scene) => (
                <div
                  key={scene.scene_id}
                  onClick={() => selectScene(scene.scene_id)}
                  className={cn(
                    "rounded-lg border p-2 cursor-pointer transition-all hover:shadow-sm",
                    selectedSceneId === scene.scene_id
                      ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                      : "border-border/50 hover:border-border",
                  )}
                >
                  <div className="flex items-start gap-2">
                    <div className="w-10 h-10 rounded-lg bg-muted/50 flex items-center justify-center shrink-0 overflow-hidden">
                      {scene.anchor_image ? (
                        <img src={scene.anchor_image} alt={scene.name} className="w-full h-full object-cover" />
                      ) : (
                        <MapPin className="h-4 w-4 text-muted-foreground/40" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium truncate">{scene.name}</p>
                      <p className="text-[10px] text-muted-foreground line-clamp-2 leading-tight">
                        {scene.description.slice(0, 60)}...
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Global Style */}
          <section>
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 mb-2 flex items-center gap-1">
              <Palette className="h-3 w-3" /> 全局风格
            </h3>
            <div className="rounded-lg border border-border/50 p-2 space-y-1 text-[10px] text-muted-foreground">
              <p>视觉: {project.style_profile.visual_style || "自动"}</p>
              <p>色调: {project.style_profile.color_tone || "自动"}</p>
              <p>配乐: {project.audio_profile.bgm_style || "自动"}</p>
              <p>比例: {project.style_profile.aspect_ratio}</p>
            </div>
          </section>
        </div>
      </ScrollArea>
    </div>
  );
}
