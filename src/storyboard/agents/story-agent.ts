/**
 * Agent 2: Story & Storyboard Agent — with streaming support.
 * Generates characters, scenes, and shot sequences from user input.
 * Reports real-time progress to the AgentActivity store.
 */
import { streamChatCompletion, parseJsonResponse } from "../api/deepseek";
import { useAgentActivityStore } from "../stores/agent-activity.store";
import type { Character, Scene, Shot, StyleProfile, AudioProfile } from "../types";

interface StoryGenerationResult {
  characters: Omit<Character, "character_id" | "project_id" | "anchor_images" | "version">[];
  scenes: Omit<Scene, "scene_id" | "project_id" | "anchor_image" | "version">[];
  shots: any[];
  warnings: string[];
}

const SYSTEM_PROMPT = `You are a professional film director and screenwriter AI. Given a story description, generate a complete short video storyboard.

Output STRICT JSON with this structure:
{
  "characters": [
    {
      "name": "string",
      "visual_description": "detailed appearance for AI image generation",
      "personality": "brief personality",
      "role_in_story": "protagonist/antagonist/supporting",
      "voice_id": null,
      "status": "alive"
    }
  ],
  "scenes": [
    {
      "name": "scene name",
      "description": "detailed environment description for AI generation",
      "lighting": "lighting conditions",
      "weather": "weather",
      "time_of_day": "morning/afternoon/evening/night",
      "mood": "atmosphere tag"
    }
  ],
  "shots": [
    {
      "sequence_number": 1,
      "act_number": 1,
      "scene_name": "references scene by name",
      "character_names": ["references characters by name"],
      "shot_type": "wide|medium|close_up|extreme_close_up|over_shoulder|pov|aerial",
      "camera_movement": "static|pan_left|pan_right|tilt_up|tilt_down|dolly_in|dolly_out|tracking|handheld",
      "duration": 6,
      "dialogue": "optional dialogue text or null",
      "dialogue_character": "character name or null",
      "narration": "optional narration or null",
      "action_description": "what happens in this shot",
      "emotion_tag": "tense|joyful|melancholy|neutral|explosive|mysterious|romantic|horror",
      "generation_prompt": "complete prompt for video generation model",
      "negative_prompt": "what to avoid",
      "transition_to_next": "cut|fade|dissolve|wipe|match_cut",
      "is_key_shot": false
    }
  ],
  "warnings": ["any narrative consistency warnings"]
}

Rules:
- For a 3-minute video, generate 15-30 shots (4-12 seconds each)
- Total duration should approximate the target duration
- Each shot's generation_prompt must include character appearance anchors, scene details, camera info
- Maintain narrative consistency: character states, cause-effect chains, emotional arc
- Mark pivotal moments as is_key_shot: true
- Use varied shot types and camera movements for cinematic feel`;

/**
 * Generate story with streaming — yields tokens to the activity panel in real-time.
 */
export async function generateStoryStreaming(
  userPrompt: string,
  styleProfile: StyleProfile,
  audioProfile: AudioProfile,
  targetDuration: number,
  phaseId: string,
): Promise<StoryGenerationResult> {
  const activity = useAgentActivityStore.getState();

  const userMessage = `Story request: "${userPrompt}"

Style: ${styleProfile.visual_style || "auto-detect from story"}, color tone: ${styleProfile.color_tone || "auto"}, aspect ratio: ${styleProfile.aspect_ratio}
Audio style: ${audioProfile.bgm_style || "auto"}, SFX density: ${audioProfile.sfx_density}
Target duration: ${targetDuration} seconds (approximately ${Math.round(targetDuration / 60)} minutes)

Generate the complete storyboard now.`;

  // Start streaming task
  const taskId = activity.startTask(phaseId, "story", "🎬 创作Agent: 生成故事与分镜");

  let fullText = "";
  try {
    const stream = streamChatCompletion(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      { temperature: 0.8, max_tokens: 8192 },
    );

    for await (const chunk of stream) {
      fullText += chunk;
      useAgentActivityStore.getState().appendStream(taskId, chunk);
    }

    const result = parseJsonResponse<StoryGenerationResult>(fullText);
    useAgentActivityStore.getState().completeTask(
      taskId,
      `✅ ${result.characters?.length || 0} 角色, ${result.scenes?.length || 0} 场景, ${result.shots?.length || 0} 镜头`,
    );
    return result;
  } catch (err: any) {
    useAgentActivityStore.getState().failTask(taskId, err.message);
    throw err;
  }
}

/**
 * Parse user intent with streaming feedback.
 */
export async function parseUserIntentStreaming(
  message: string,
  projectContext: { shotCount: number; characterNames: string[]; sceneNames: string[] },
  phaseId: string,
): Promise<{
  type: "new_project" | "modify_shot" | "modify_character" | "modify_scene" | "modify_global" | "generate" | "export" | "chat";
  target_id?: string;
  target_name?: string;
  details?: string;
}> {
  const activity = useAgentActivityStore.getState();
  const taskId = activity.startTask(phaseId, "orchestrator", "🧠 主控Agent: 解析用户意图");

  let fullText = "";
  try {
    const stream = streamChatCompletion(
      [
        {
          role: "system",
          content: `You are an intent parser. Given a user message and project context, determine the intent.
Return JSON: { "type": "new_project|modify_shot|modify_character|modify_scene|modify_global|generate|export|chat", "target_name": "optional name", "details": "extracted details" }
Context: ${projectContext.shotCount} shots, characters: [${projectContext.characterNames.join(",")}], scenes: [${projectContext.sceneNames.join(",")}]`,
        },
        { role: "user", content: message },
      ],
      { temperature: 0.2, max_tokens: 512 },
    );

    for await (const chunk of stream) {
      fullText += chunk;
      useAgentActivityStore.getState().appendStream(taskId, chunk);
    }

    const result = parseJsonResponse<any>(fullText);
    useAgentActivityStore.getState().completeTask(taskId, `意图: ${result.type}`);
    return result;
  } catch (err: any) {
    useAgentActivityStore.getState().failTask(taskId, err.message);
    throw err;
  }
}

/**
 * Modify a single shot with streaming feedback.
 */
export async function modifyShotStreaming(
  shot: Shot,
  instruction: string,
  characters: Character[],
  scene: Scene,
  phaseId: string,
): Promise<Partial<Shot>> {
  const activity = useAgentActivityStore.getState();
  const taskId = activity.startTask(phaseId, "story", "✏️ 创作Agent: 修改镜头 #" + shot.sequence_number);

  let fullText = "";
  try {
    const stream = streamChatCompletion(
      [
        {
          role: "system",
          content: `You are a film director. Modify the given shot based on the user's instruction. Return ONLY the changed fields as JSON. Keep unchanged fields out of the response.`,
        },
        {
          role: "user",
          content: `Current shot: ${JSON.stringify(shot)}
Characters: ${characters.map((c) => c.name + ": " + c.visual_description).join("; ")}
Scene: ${scene.name} - ${scene.description}
Instruction: ${instruction}`,
        },
      ],
      { temperature: 0.5, max_tokens: 2048 },
    );

    for await (const chunk of stream) {
      fullText += chunk;
      useAgentActivityStore.getState().appendStream(taskId, chunk);
    }

    const result = parseJsonResponse<Partial<Shot>>(fullText);
    useAgentActivityStore.getState().completeTask(taskId, `已修改镜头 #${shot.sequence_number}`);
    return result;
  } catch (err: any) {
    useAgentActivityStore.getState().failTask(taskId, err.message);
    throw err;
  }
}
