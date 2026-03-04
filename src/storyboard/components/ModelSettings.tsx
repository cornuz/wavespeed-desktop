/**
 * Model Settings — collapsible panel showing current model selections.
 * Default collapsed, click to expand and see/change models per category.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ChevronDown,
  ChevronRight,
  Film,
  Image,
  Volume2,
  Brain,
  Settings2,
} from "lucide-react";
import {
  MODEL_OPTIONS,
  type ModelCategory,
  type ModelOption,
} from "../models/model-config";

interface ModelSettingsProps {
  selectedModels: Record<ModelCategory, ModelOption>;
  onModelChange: (category: ModelCategory, model: ModelOption) => void;
}

const CATEGORY_META: Record<ModelCategory, { icon: typeof Film; label: string }> = {
  video: { icon: Film, label: "视频模型" },
  image: { icon: Image, label: "图片模型" },
  tts: { icon: Volume2, label: "语音模型" },
  llm: { icon: Brain, label: "语言模型" },
};

export function ModelSettings({ selectedModels, onModelChange }: ModelSettingsProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="sm"
        className="h-7 text-[10px] px-2 gap-1"
        onClick={() => setIsOpen(!isOpen)}
      >
        <Settings2 className="h-3 w-3" />
        模型
        {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      </Button>

      {isOpen && (
        <div className="absolute top-full right-0 mt-1 z-50 w-72 rounded-lg border bg-popover p-3 shadow-lg space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold">模型配置</span>
            <span className="text-[9px] text-muted-foreground">每类别1个模型</span>
          </div>

          {(Object.keys(CATEGORY_META) as ModelCategory[]).map((category) => {
            const meta = CATEGORY_META[category];
            const Icon = meta.icon;
            const options = MODEL_OPTIONS[category];
            const selected = selectedModels[category];

            return (
              <div key={category} className="space-y-1">
                <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <Icon className="h-3 w-3" />
                  <span>{meta.label}</span>
                </div>
                <Select
                  value={selected.id}
                  onValueChange={(val) => {
                    const model = options.find((m) => m.id === val);
                    if (model) onModelChange(category, model);
                  }}
                >
                  <SelectTrigger className="h-7 text-[10px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {options.map((opt) => (
                      <SelectItem key={opt.id} value={opt.id} className="text-[10px]">
                        <div>
                          <div>{opt.name}</div>
                          <div className="text-[9px] text-muted-foreground">{opt.description}</div>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            );
          })}

          <div className="pt-1 border-t text-[9px] text-muted-foreground">
            视频: {selectedModels.video.name} | 图片: {selectedModels.image.name}
          </div>
        </div>
      )}
    </div>
  );
}
