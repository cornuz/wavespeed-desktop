/**
 * Main storyboard store — manages project, characters, scenes, shots, and agent state.
 * Uses streaming agents with real-time activity reporting.
 */
import { create } from "zustand";
import { v4 as uuid } from "uuid";
import type {
  Project,
  ProjectMode,
  ProjectStatus,
  Character,
  Scene,
  Shot,
  DependencyEdge,
  EditHistoryEntry,
  StyleProfile,
  AudioProfile,
  GenerationStatus,
} from "../types";
import { generateStoryStreaming, parseUserIntentStreaming, modifyShotStreaming } from "../agents/story-agent";
import { setDeepSeekApiKey, setDeepSeekBaseUrl, setDeepSeekModel } from "../api/deepseek";
import { useAgentActivityStore } from "./agent-activity.store";
import { DEFAULT_MODELS, type ModelCategory, type ModelOption } from "../models/model-config";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
}

interface StoryboardState {
  // Project
  project: Project | null;
  characters: Character[];
  scenes: Scene[];
  shots: Shot[];
  edges: DependencyEdge[];
  editHistory: EditHistoryEntry[];
  chatMessages: ChatMessage[];

  // UI state
  selectedShotId: string | null;
  selectedCharacterId: string | null;
  selectedSceneId: string | null;
  isAgentWorking: boolean;
  error: string | null;

  // Model selection
  selectedModels: Record<ModelCategory, ModelOption>;

  // Actions
  initProject: (name: string, mode: ProjectMode, prompt: string) => Promise<void>;
  setApiKey: (key: string) => void;
  setLlmConfig: (config: { apiKey?: string; baseUrl?: string; model?: string }) => void;
  setModel: (category: ModelCategory, model: ModelOption) => void;
  selectShot: (id: string | null) => void;
  selectCharacter: (id: string | null) => void;
  selectScene: (id: string | null) => void;
  sendMessage: (message: string) => Promise<void>;
  updateShot: (shotId: string, updates: Partial<Shot>) => void;
  updateCharacter: (charId: string, updates: Partial<Character>) => void;
  updateScene: (sceneId: string, updates: Partial<Scene>) => void;
  regenerateShot: (shotId: string) => void;
  markDirty: (shotIds: string[]) => void;
  deleteShotById: (shotId: string) => void;
  insertShotAfter: (afterShotId: string, description: string) => Promise<void>;
  reorderShot: (shotId: string, newIndex: number) => void;
  setProjectStatus: (status: ProjectStatus) => void;
  toggleMode: () => void;
  computeDirtyPropagation: (changedEntityType: string, entityId: string) => string[];
  reset: () => void;
}

const defaultStyleProfile: StyleProfile = {
  visual_style: "",
  color_tone: "",
  aspect_ratio: "16:9",
  reference_images: [],
};

const defaultAudioProfile: AudioProfile = {
  bgm_style: "",
  narration_voice: null,
  sfx_density: "normal",
};

function buildDependencyEdges(shots: Shot[]): DependencyEdge[] {
  const edges: DependencyEdge[] = [];
  const sorted = [...shots].sort((a, b) => a.sequence_number - b.sequence_number);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (prev.scene_id === curr.scene_id) {
      edges.push({ from: prev.shot_id, to: curr.shot_id, type: "frame_chain" });
    }
    edges.push({ from: prev.shot_id, to: curr.shot_id, type: "narrative_order" });
  }
  return edges;
}

export const useStoryboardStore = create<StoryboardState>((set, get) => ({
  project: null,
  characters: [],
  scenes: [],
  shots: [],
  edges: [],
  editHistory: [],
  chatMessages: [],
  selectedShotId: null,
  selectedCharacterId: null,
  selectedSceneId: null,
  isAgentWorking: false,
  error: null,

  selectedModels: { ...DEFAULT_MODELS },

  setApiKey: (key: string) => setDeepSeekApiKey(key),

  setLlmConfig: (config) => {
    if (config.apiKey) setDeepSeekApiKey(config.apiKey);
    if (config.baseUrl) setDeepSeekBaseUrl(config.baseUrl);
    if (config.model) setDeepSeekModel(config.model);
  },

  setModel: (category, model) =>
    set((s) => ({
      selectedModels: { ...s.selectedModels, [category]: model },
    })),

  selectShot: (id) => set({ selectedShotId: id, selectedCharacterId: null, selectedSceneId: null }),
  selectCharacter: (id) => set({ selectedCharacterId: id, selectedShotId: null, selectedSceneId: null }),
  selectScene: (id) => set({ selectedSceneId: id, selectedShotId: null, selectedCharacterId: null }),

  setProjectStatus: (status) =>
    set((s) => s.project ? { project: { ...s.project, status, updated_at: Date.now() } } : {}),

  toggleMode: () =>
    set((s) => {
      if (!s.project) return {};
      const newMode: ProjectMode = s.project.mode === "lite" ? "pro" : "lite";
      return { project: { ...s.project, mode: newMode, updated_at: Date.now() } };
    }),

  initProject: async (name, mode, prompt) => {
    const projectId = uuid();
    const project: Project = {
      project_id: projectId,
      name,
      mode,
      status: "creating",
      style_profile: defaultStyleProfile,
      audio_profile: defaultAudioProfile,
      target_duration: 180,
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    // Reset activity store and start new phase
    const activityStore = useAgentActivityStore.getState();
    activityStore.reset();

    set({
      project,
      isAgentWorking: true,
      chatMessages: [
        { id: uuid(), role: "user", content: prompt, timestamp: Date.now() },
      ],
      error: null,
    });

    const phaseId = activityStore.startPhase("阶段一：对话创作");

    // Orchestrator task — intent analysis
    const orchTaskId = activityStore.startTask(phaseId, "orchestrator", "🧠 主控Agent: 分析请求类型");
    activityStore.appendStream(orchTaskId, "检测到新项目创建请求...\n");
    activityStore.appendStream(orchTaskId, `项目名称: ${name}\n模式: ${mode}\n目标时长: 180秒\n`);
    activityStore.appendStream(orchTaskId, "路由到创作Agent...\n");
    activityStore.completeTask(orchTaskId, "✅ 已路由到创作Agent");

    try {
      // Story generation with streaming
      const result = await generateStoryStreaming(
        prompt,
        project.style_profile,
        project.audio_profile,
        project.target_duration,
        phaseId,
      );

      // Data assembly task
      const assembleTaskId = activityStore.startTask(phaseId, "orchestrator", "📦 主控Agent: 组装项目数据");

      // Map characters
      const characters: Character[] = (result.characters || []).map((c) => ({
        ...c,
        character_id: uuid(),
        project_id: projectId,
        anchor_images: { front: null, side: null, full_body: null },
        version: 1,
      }));
      activityStore.appendStream(assembleTaskId, `已创建 ${characters.length} 个角色卡\n`);

      // Map scenes
      const scenes: Scene[] = (result.scenes || []).map((s) => ({
        ...s,
        scene_id: uuid(),
        project_id: projectId,
        anchor_image: null,
        version: 1,
      }));
      activityStore.appendStream(assembleTaskId, `已创建 ${scenes.length} 个场景卡\n`);

      // Map shots
      const charMap = new Map(characters.map((c) => [c.name, c.character_id]));
      const sceneMap = new Map(scenes.map((s) => [s.name, s.scene_id]));

      const shots: Shot[] = (result.shots || []).map((s: any, i: number) => ({
        shot_id: uuid(),
        project_id: projectId,
        sequence_number: s.sequence_number ?? i + 1,
        act_number: s.act_number ?? 1,
        scene_id: sceneMap.get(s.scene_name) ?? scenes[0]?.scene_id ?? "",
        character_ids: (s.character_names || []).map((n: string) => charMap.get(n) ?? "").filter(Boolean),
        shot_type: s.shot_type ?? "medium",
        camera_movement: s.camera_movement ?? "static",
        duration: s.duration ?? 6,
        dialogue: s.dialogue ?? null,
        dialogue_character: s.dialogue_character ? (charMap.get(s.dialogue_character) ?? null) : null,
        narration: s.narration ?? null,
        action_description: s.action_description ?? "",
        emotion_tag: s.emotion_tag ?? "neutral",
        generation_prompt: s.generation_prompt ?? "",
        negative_prompt: s.negative_prompt ?? "",
        transition_to_next: s.transition_to_next ?? "cut",
        is_key_shot: s.is_key_shot ?? false,
        dependencies: [],
        generation_status: "pending" as GenerationStatus,
        generated_assets: {
          video_path: null, video_versions: [], selected_version: 0,
          dialogue_audio: null, narration_audio: null, sfx_audio: null,
          last_frame_path: null, thumbnail: null,
        },
        qc_score: 0,
        qc_warnings: [],
      }));

      activityStore.appendStream(assembleTaskId, `已创建 ${shots.length} 个镜头\n`);

      const edges = buildDependencyEdges(shots);
      for (const shot of shots) {
        shot.dependencies = edges.filter((e) => e.to === shot.shot_id).map((e) => e.from);
      }

      activityStore.appendStream(assembleTaskId, `已构建 ${edges.length} 条依赖关系\n`);

      const totalDuration = shots.reduce((sum, s) => sum + s.duration, 0);
      activityStore.completeTask(assembleTaskId, `✅ 项目数据组装完成 (${totalDuration}s)`);
      activityStore.completePhase(phaseId);

      const warnings = result.warnings || [];

      set({
        project: { ...project, status: "ready", updated_at: Date.now() },
        characters,
        scenes,
        shots,
        edges,
        isAgentWorking: false,
        chatMessages: [
          ...get().chatMessages,
          {
            id: uuid(),
            role: "assistant",
            content: `已生成 ${characters.length} 个角色、${scenes.length} 个场景、${shots.length} 个镜头。预计总时长 ${totalDuration}秒。${warnings.length > 0 ? "\n⚠️ " + warnings.join("\n⚠️ ") : ""}`,
            timestamp: Date.now(),
          },
        ],
      });
    } catch (err: any) {
      activityStore.completePhase(phaseId);
      set({
        isAgentWorking: false,
        error: err.message || "Story generation failed",
        project: { ...project, status: "idle" },
        chatMessages: [
          ...get().chatMessages,
          { id: uuid(), role: "system", content: `❌ 生成失败: ${err.message}`, timestamp: Date.now() },
        ],
      });
    }
  },

  sendMessage: async (message) => {
    const state = get();
    const newMsg: ChatMessage = { id: uuid(), role: "user", content: message, timestamp: Date.now() };
    set({ chatMessages: [...state.chatMessages, newMsg] });

    if (!state.project) {
      await get().initProject("新项目", "lite", message);
      return;
    }

    set({ isAgentWorking: true });
    const activityStore = useAgentActivityStore.getState();
    const phaseId = activityStore.startPhase("用户指令处理");

    try {
      const intent = await parseUserIntentStreaming(message, {
        shotCount: state.shots.length,
        characterNames: state.characters.map((c) => c.name),
        sceneNames: state.scenes.map((s) => s.name),
      }, phaseId);

      if (intent.type === "modify_shot" && intent.target_name) {
        const shotNum = parseInt(intent.target_name);
        const targetShot = !isNaN(shotNum)
          ? state.shots.find((s) => s.sequence_number === shotNum)
          : state.shots.find((s) => s.action_description.includes(intent.target_name!));

        if (targetShot) {
          const scene = state.scenes.find((s) => s.scene_id === targetShot.scene_id);
          const chars = state.characters.filter((c) => targetShot.character_ids.includes(c.character_id));
          const updates = await modifyShotStreaming(targetShot, intent.details || message, chars, scene!, phaseId);
          get().updateShot(targetShot.shot_id, { ...updates, generation_status: "dirty" });
          set({
            chatMessages: [...get().chatMessages, { id: uuid(), role: "assistant", content: `已修改镜头 #${targetShot.sequence_number}`, timestamp: Date.now() }],
          });
        }
      } else if (intent.type === "generate") {
        get().setProjectStatus("generating");
        set({
          chatMessages: [...get().chatMessages, { id: uuid(), role: "assistant", content: "开始生成视频...", timestamp: Date.now() }],
        });
      } else {
        set({
          chatMessages: [...get().chatMessages, { id: uuid(), role: "assistant", content: `收到。${intent.details || ""}`, timestamp: Date.now() }],
        });
      }

      activityStore.completePhase(phaseId);
    } catch (err: any) {
      activityStore.completePhase(phaseId);
      set({
        chatMessages: [...get().chatMessages, { id: uuid(), role: "system", content: `❌ ${err.message}`, timestamp: Date.now() }],
      });
    } finally {
      set({ isAgentWorking: false });
    }
  },

  updateShot: (shotId, updates) =>
    set((s) => ({
      shots: s.shots.map((shot) =>
        shot.shot_id === shotId ? { ...shot, ...updates, generation_status: updates.generation_status ?? "dirty" } : shot,
      ),
    })),

  updateCharacter: (charId, updates) =>
    set((s) => ({
      characters: s.characters.map((c) =>
        c.character_id === charId ? { ...c, ...updates, version: c.version + 1 } : c,
      ),
    })),

  updateScene: (sceneId, updates) =>
    set((s) => ({
      scenes: s.scenes.map((sc) =>
        sc.scene_id === sceneId ? { ...sc, ...updates, version: sc.version + 1 } : sc,
      ),
    })),

  regenerateShot: (shotId) =>
    set((s) => ({
      shots: s.shots.map((shot) =>
        shot.shot_id === shotId ? { ...shot, generation_status: "pending" as GenerationStatus } : shot,
      ),
    })),

  markDirty: (shotIds) =>
    set((s) => ({
      shots: s.shots.map((shot) =>
        shotIds.includes(shot.shot_id) ? { ...shot, generation_status: "dirty" as GenerationStatus } : shot,
      ),
    })),

  deleteShotById: (shotId) =>
    set((s) => {
      const remaining = s.shots.filter((sh) => sh.shot_id !== shotId);
      const sorted = remaining.sort((a, b) => a.sequence_number - b.sequence_number);
      sorted.forEach((sh, i) => { sh.sequence_number = i + 1; });
      return { shots: sorted, edges: buildDependencyEdges(sorted), selectedShotId: null };
    }),

  insertShotAfter: async (afterShotId, description) => {
    const s = get();
    const afterShot = s.shots.find((sh) => sh.shot_id === afterShotId);
    if (!afterShot) return;

    const newShot: Shot = {
      shot_id: uuid(),
      project_id: s.project?.project_id ?? "",
      sequence_number: afterShot.sequence_number + 0.5,
      act_number: afterShot.act_number,
      scene_id: afterShot.scene_id,
      character_ids: [],
      shot_type: "medium",
      camera_movement: "static",
      duration: 6,
      dialogue: null,
      dialogue_character: null,
      narration: null,
      action_description: description,
      emotion_tag: "neutral",
      generation_prompt: "",
      negative_prompt: "",
      transition_to_next: "cut",
      is_key_shot: false,
      dependencies: [],
      generation_status: "pending",
      generated_assets: { video_path: null, video_versions: [], selected_version: 0, dialogue_audio: null, narration_audio: null, sfx_audio: null, last_frame_path: null, thumbnail: null },
      qc_score: 0,
      qc_warnings: [],
    };

    const allShots = [...s.shots, newShot].sort((a, b) => a.sequence_number - b.sequence_number);
    allShots.forEach((sh, i) => { sh.sequence_number = i + 1; });
    set({ shots: allShots, edges: buildDependencyEdges(allShots) });
  },

  reorderShot: (shotId, newIndex) =>
    set((s) => {
      const shots = [...s.shots].sort((a, b) => a.sequence_number - b.sequence_number);
      const idx = shots.findIndex((sh) => sh.shot_id === shotId);
      if (idx === -1) return {};
      const [moved] = shots.splice(idx, 1);
      shots.splice(newIndex, 0, moved);
      shots.forEach((sh, i) => { sh.sequence_number = i + 1; });
      return { shots, edges: buildDependencyEdges(shots) };
    }),

  computeDirtyPropagation: (changedEntityType, entityId) => {
    const s = get();
    const dirtyIds: string[] = [];
    if (changedEntityType === "character") {
      s.shots.forEach((shot) => { if (shot.character_ids.includes(entityId)) dirtyIds.push(shot.shot_id); });
    } else if (changedEntityType === "scene") {
      s.shots.forEach((shot) => { if (shot.scene_id === entityId) dirtyIds.push(shot.shot_id); });
    } else if (changedEntityType === "global_style") {
      s.shots.forEach((shot) => dirtyIds.push(shot.shot_id));
    } else if (changedEntityType === "shot") {
      const downstream = new Set<string>();
      const queue = [entityId];
      while (queue.length > 0) {
        const current = queue.shift()!;
        s.edges.filter((e) => e.from === current && e.type === "frame_chain").forEach((e) => {
          if (!downstream.has(e.to)) { downstream.add(e.to); queue.push(e.to); }
        });
      }
      downstream.forEach((id) => dirtyIds.push(id));
    }
    return dirtyIds;
  },

  reset: () => {
    useAgentActivityStore.getState().reset();
    set({
      project: null, characters: [], scenes: [], shots: [], edges: [],
      editHistory: [], chatMessages: [], selectedShotId: null,
      selectedCharacterId: null, selectedSceneId: null,
      isAgentWorking: false, error: null,
      selectedModels: { ...DEFAULT_MODELS },
    });
  },
}));
