/**
 * Right panel — Shot detail editor (Pro mode shows all fields, Lite mode shows minimal).
 */
import { useState, useEffect } from "react";
import { useStoryboardStore } from "../stores/storyboard.store";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { RefreshCw, Save, X } from "lucide-react";
import type { ShotType, CameraMovement, EmotionTag, TransitionType } from "../types";

const SHOT_TYPES: { value: ShotType; label: string }[] = [
  { value: "wide", label: "全景" },
  { value: "medium", label: "中景" },
  { value: "close_up", label: "特写" },
  { value: "extreme_close_up", label: "大特写" },
  { value: "over_shoulder", label: "过肩" },
  { value: "pov", label: "主观" },
  { value: "aerial", label: "俯拍" },
];

const CAMERA_MOVEMENTS: { value: CameraMovement; label: string }[] = [
  { value: "static", label: "静止" },
  { value: "pan_left", label: "左摇" },
  { value: "pan_right", label: "右摇" },
  { value: "tilt_up", label: "上摇" },
  { value: "tilt_down", label: "下摇" },
  { value: "dolly_in", label: "推进" },
  { value: "dolly_out", label: "拉远" },
  { value: "tracking", label: "跟踪" },
  { value: "handheld", label: "手持" },
];

const EMOTIONS: { value: EmotionTag; label: string }[] = [
  { value: "neutral", label: "平静" },
  { value: "tense", label: "紧张" },
  { value: "joyful", label: "欢乐" },
  { value: "melancholy", label: "忧郁" },
  { value: "explosive", label: "爆发" },
  { value: "mysterious", label: "神秘" },
  { value: "romantic", label: "浪漫" },
  { value: "horror", label: "恐怖" },
];

const TRANSITIONS: { value: TransitionType; label: string }[] = [
  { value: "cut", label: "硬切" },
  { value: "fade", label: "淡入淡出" },
  { value: "dissolve", label: "溶解" },
  { value: "wipe", label: "擦除" },
  { value: "match_cut", label: "匹配剪辑" },
];

export function RightPanel() {
  const selectedShotId = useStoryboardStore((s) => s.selectedShotId);
  const shots = useStoryboardStore((s) => s.shots);
  const characters = useStoryboardStore((s) => s.characters);
  const project = useStoryboardStore((s) => s.project);
  const updateShot = useStoryboardStore((s) => s.updateShot);
  const regenerateShot = useStoryboardStore((s) => s.regenerateShot);
  const selectShot = useStoryboardStore((s) => s.selectShot);

  const shot = shots.find((s) => s.shot_id === selectedShotId);
  const isPro = project?.mode === "pro";

  // Local edit state
  const [desc, setDesc] = useState("");
  const [dialogue, setDialogue] = useState("");
  const [narration, setNarration] = useState("");
  const [shotType, setShotType] = useState<ShotType>("medium");
  const [cameraMove, setCameraMove] = useState<CameraMovement>("static");
  const [duration, setDuration] = useState(6);
  const [emotion, setEmotion] = useState<EmotionTag>("neutral");
  const [transition, setTransition] = useState<TransitionType>("cut");
  const [prompt, setPrompt] = useState("");
  const [negPrompt, setNegPrompt] = useState("");

  useEffect(() => {
    if (shot) {
      setDesc(shot.action_description);
      setDialogue(shot.dialogue || "");
      setNarration(shot.narration || "");
      setShotType(shot.shot_type);
      setCameraMove(shot.camera_movement);
      setDuration(shot.duration);
      setEmotion(shot.emotion_tag);
      setTransition(shot.transition_to_next);
      setPrompt(shot.generation_prompt);
      setNegPrompt(shot.negative_prompt);
    }
  }, [shot]);

  if (!shot) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground/40 text-xs text-center p-4">
        选择一个镜头节点查看详情
      </div>
    );
  }

  const handleSave = () => {
    updateShot(shot.shot_id, {
      action_description: desc,
      dialogue: dialogue || null,
      narration: narration || null,
      shot_type: shotType,
      camera_movement: cameraMove,
      duration,
      emotion_tag: emotion,
      transition_to_next: transition,
      generation_prompt: prompt,
      negative_prompt: negPrompt,
    });
  };

  const shotChars = characters.filter((c) => shot.character_ids.includes(c.character_id));

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between p-3 border-b">
        <h3 className="text-xs font-semibold">Shot #{shot.sequence_number}</h3>
        <button onClick={() => selectShot(null)} className="text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-3 space-y-3">
          {/* Action description */}
          <div className="space-y-1">
            <Label className="text-[10px]">📝 动作描述</Label>
            <Textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              className="text-xs min-h-[60px] resize-none"
            />
          </div>

          {/* Dialogue */}
          <div className="space-y-1">
            <Label className="text-[10px]">💬 对白</Label>
            {shotChars.length > 0 && (
              <p className="text-[9px] text-muted-foreground">
                角色: {shotChars.map((c) => c.name).join(", ")}
              </p>
            )}
            <Textarea
              value={dialogue}
              onChange={(e) => setDialogue(e.target.value)}
              placeholder="无对白"
              className="text-xs min-h-[40px] resize-none"
            />
          </div>

          {isPro && (
            <>
              {/* Narration */}
              <div className="space-y-1">
                <Label className="text-[10px]">🎙 旁白</Label>
                <Textarea
                  value={narration}
                  onChange={(e) => setNarration(e.target.value)}
                  placeholder="无旁白"
                  className="text-xs min-h-[40px] resize-none"
                />
              </div>

              {/* Shot type */}
              <div className="space-y-1">
                <Label className="text-[10px]">🎬 景别</Label>
                <Select value={shotType} onValueChange={(v) => setShotType(v as ShotType)}>
                  <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {SHOT_TYPES.map((st) => (
                      <SelectItem key={st.value} value={st.value} className="text-xs">{st.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Camera movement */}
              <div className="space-y-1">
                <Label className="text-[10px]">📷 运镜</Label>
                <Select value={cameraMove} onValueChange={(v) => setCameraMove(v as CameraMovement)}>
                  <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CAMERA_MOVEMENTS.map((cm) => (
                      <SelectItem key={cm.value} value={cm.value} className="text-xs">{cm.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Duration */}
              <div className="space-y-1">
                <Label className="text-[10px]">⏱ 时长: {duration}s</Label>
                <Slider
                  value={[duration]}
                  onValueChange={([v]) => setDuration(v)}
                  min={4}
                  max={12}
                  step={1}
                  className="py-1"
                />
              </div>

              {/* Emotion */}
              <div className="space-y-1">
                <Label className="text-[10px]">🎭 情绪</Label>
                <Select value={emotion} onValueChange={(v) => setEmotion(v as EmotionTag)}>
                  <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {EMOTIONS.map((em) => (
                      <SelectItem key={em.value} value={em.value} className="text-xs">{em.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Transition */}
              <div className="space-y-1">
                <Label className="text-[10px]">🔗 转场</Label>
                <Select value={transition} onValueChange={(v) => setTransition(v as TransitionType)}>
                  <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TRANSITIONS.map((tr) => (
                      <SelectItem key={tr.value} value={tr.value} className="text-xs">{tr.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Generation prompt */}
              <div className="space-y-1">
                <Label className="text-[10px]">🤖 生成Prompt</Label>
                <Textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  className="text-[10px] min-h-[80px] resize-none font-mono"
                />
              </div>

              {/* Negative prompt */}
              <div className="space-y-1">
                <Label className="text-[10px]">🚫 负面提示词</Label>
                <Textarea
                  value={negPrompt}
                  onChange={(e) => setNegPrompt(e.target.value)}
                  className="text-[10px] min-h-[40px] resize-none font-mono"
                />
              </div>
            </>
          )}
        </div>
      </ScrollArea>

      {/* Action buttons */}
      <div className="p-3 border-t flex gap-2">
        <Button size="sm" variant="outline" className="flex-1 text-xs h-7" onClick={handleSave}>
          <Save className="h-3 w-3 mr-1" /> 保存
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="flex-1 text-xs h-7"
          onClick={() => regenerateShot(shot.shot_id)}
        >
          <RefreshCw className="h-3 w-3 mr-1" /> 重新生成
        </Button>
      </div>
    </div>
  );
}
