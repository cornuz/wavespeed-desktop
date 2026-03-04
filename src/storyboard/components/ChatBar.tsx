/**
 * Bottom chat bar — conversation input + timeline preview.
 */
import { useState, useRef, useEffect } from "react";
import { useStoryboardStore } from "../stores/storyboard.store";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Send, Loader2, Bot, User, AlertCircle } from "lucide-react";

export function ChatBar() {
  const [input, setInput] = useState("");
  const chatMessages = useStoryboardStore((s) => s.chatMessages);
  const isAgentWorking = useStoryboardStore((s) => s.isAgentWorking);
  const sendMessage = useStoryboardStore((s) => s.sendMessage);
  const shots = useStoryboardStore((s) => s.shots);
  const project = useStoryboardStore((s) => s.project);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  const handleSend = async () => {
    if (!input.trim() || isAgentWorking) return;
    const msg = input.trim();
    setInput("");
    await sendMessage(msg);
  };

  const totalDuration = shots.reduce((sum, s) => sum + s.duration, 0);
  const doneCount = shots.filter((s) => s.generation_status === "done").length;
  const targetDuration = project?.target_duration ?? 180;

  return (
    <div className="border-t bg-background/80 backdrop-blur shrink-0">
      {/* Timeline preview */}
      {shots.length > 0 && (
        <div className="px-3 py-1.5 border-b flex items-center gap-2 overflow-x-auto">
          <div className="flex items-center gap-0.5 shrink-0">
            {shots
              .sort((a, b) => a.sequence_number - b.sequence_number)
              .map((shot) => {
                const widthPx = Math.max(20, (shot.duration / targetDuration) * 600);
                const colors: Record<string, string> = {
                  pending: "bg-muted-foreground/20",
                  generating: "bg-blue-500/50 animate-pulse",
                  done: "bg-green-500/40",
                  failed: "bg-red-500/40",
                  dirty: "bg-yellow-500/40",
                };
                return (
                  <div
                    key={shot.shot_id}
                    className={cn("h-4 rounded-sm", colors[shot.generation_status])}
                    style={{ width: `${widthPx}px` }}
                    title={`Shot #${shot.sequence_number} - ${shot.duration}s`}
                  />
                );
              })}
          </div>
          <span className="text-[10px] text-muted-foreground shrink-0 ml-2">
            {doneCount}/{shots.length} 镜头 | {totalDuration}s / {targetDuration}s
          </span>
        </div>
      )}

      {/* Chat messages */}
      {chatMessages.length > 0 && (
        <ScrollArea className="max-h-32">
          <div className="px-3 py-2 space-y-1.5">
            {chatMessages.map((msg) => (
              <div
                key={msg.id}
                className={cn(
                  "flex items-start gap-1.5 text-xs",
                  msg.role === "user" ? "justify-end" : "",
                )}
              >
                {msg.role !== "user" && (
                  <span className="shrink-0 mt-0.5">
                    {msg.role === "assistant" ? (
                      <Bot className="h-3 w-3 text-primary" />
                    ) : (
                      <AlertCircle className="h-3 w-3 text-muted-foreground" />
                    )}
                  </span>
                )}
                <span
                  className={cn(
                    "rounded-lg px-2 py-1 max-w-[80%]",
                    msg.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : msg.role === "assistant"
                        ? "bg-muted"
                        : "bg-muted/50 text-muted-foreground italic",
                  )}
                >
                  {msg.content}
                </span>
                {msg.role === "user" && (
                  <User className="h-3 w-3 text-muted-foreground shrink-0 mt-0.5" />
                )}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        </ScrollArea>
      )}

      {/* Agent status — now shown in AgentActivityPanel */}

      {/* Input */}
      <div className="p-2 flex gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
          placeholder={project ? "描述你想修改的内容..." : "描述你想创作的故事..."}
          className="text-xs h-8"
          disabled={isAgentWorking}
        />
        <Button
          size="sm"
          className="h-8 px-3"
          onClick={handleSend}
          disabled={!input.trim() || isAgentWorking}
        >
          {isAgentWorking ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
    </div>
  );
}
