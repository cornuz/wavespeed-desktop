/**
 * LLM Settings — configurable API key, base URL, and model for the AI agent.
 * Supports DeepSeek, OpenAI-compatible endpoints, SiliconFlow, etc.
 */
import { useState } from "react";
import { useStoryboardStore } from "../stores/storyboard.store";
import { getDeepSeekApiKey, getDeepSeekBaseUrl, getDeepSeekModel } from "../api/deepseek";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Brain, ChevronDown, ChevronRight, Check } from "lucide-react";

const PRESETS = [
  { label: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
  { label: "SiliconFlow", baseUrl: "https://api.siliconflow.cn/v1", model: "deepseek-ai/DeepSeek-V3" },
  { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "deepseek/deepseek-chat" },
  { label: "自定义", baseUrl: "", model: "" },
];

export function LlmSettings() {
  const setLlmConfig = useStoryboardStore((s) => s.setLlmConfig);
  const [isOpen, setIsOpen] = useState(false);
  const [apiKey, setApiKey] = useState(getDeepSeekApiKey());
  const [baseUrl, setBaseUrl] = useState(getDeepSeekBaseUrl());
  const [model, setModel] = useState(getDeepSeekModel());
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    setLlmConfig({ apiKey, baseUrl, model });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const handlePreset = (preset: typeof PRESETS[number]) => {
    if (preset.baseUrl) setBaseUrl(preset.baseUrl);
    if (preset.model) setModel(preset.model);
  };

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="sm"
        className="h-7 text-[10px] px-2 gap-1"
        onClick={() => setIsOpen(!isOpen)}
      >
        <Brain className="h-3 w-3" />
        LLM
        {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      </Button>

      {isOpen && (
        <div className="absolute top-full right-0 mt-1 z-50 w-80 rounded-lg border bg-popover p-3 shadow-lg space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold">LLM 配置</span>
            <span className="text-[9px] text-muted-foreground">OpenAI 兼容接口</span>
          </div>

          {/* Presets */}
          <div className="flex gap-1 flex-wrap">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => handlePreset(p)}
                className="text-[9px] px-1.5 py-0.5 rounded border border-border/50 hover:bg-muted transition-colors"
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Base URL */}
          <div className="space-y-1">
            <Label className="text-[10px]">API Base URL</Label>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.deepseek.com"
              className="text-[10px] h-7"
            />
          </div>

          {/* Model */}
          <div className="space-y-1">
            <Label className="text-[10px]">模型名称</Label>
            <Input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="deepseek-chat"
              className="text-[10px] h-7"
            />
          </div>

          {/* API Key */}
          <div className="space-y-1">
            <Label className="text-[10px]">API Key</Label>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
              className="text-[10px] h-7 font-mono"
            />
          </div>

          <Button size="sm" className="w-full h-7 text-[10px]" onClick={handleSave}>
            {saved ? (
              <><Check className="h-3 w-3 mr-1" /> 已保存</>
            ) : (
              "保存配置"
            )}
          </Button>

          <div className="text-[9px] text-muted-foreground leading-relaxed">
            支持所有 OpenAI 兼容接口：DeepSeek、SiliconFlow、OpenRouter、本地 Ollama 等
          </div>
        </div>
      )}
    </div>
  );
}
