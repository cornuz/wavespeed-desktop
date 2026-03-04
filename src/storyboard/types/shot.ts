/**
 * Shot (镜头) — the core entity of the storyboard system.
 */

export type ShotType =
  | "wide"
  | "medium"
  | "close_up"
  | "extreme_close_up"
  | "over_shoulder"
  | "pov"
  | "aerial";

export type CameraMovement =
  | "static"
  | "pan_left"
  | "pan_right"
  | "tilt_up"
  | "tilt_down"
  | "dolly_in"
  | "dolly_out"
  | "tracking"
  | "handheld";

export type EmotionTag =
  | "tense"
  | "joyful"
  | "melancholy"
  | "neutral"
  | "explosive"
  | "mysterious"
  | "romantic"
  | "horror";

export type TransitionType =
  | "cut"
  | "fade"
  | "dissolve"
  | "wipe"
  | "match_cut";

export type GenerationStatus =
  | "pending"
  | "generating"
  | "done"
  | "failed"
  | "dirty";

export interface GeneratedAssets {
  video_path: string | null;
  video_versions: string[];
  selected_version: number;
  dialogue_audio: string | null;
  narration_audio: string | null;
  sfx_audio: string | null;
  last_frame_path: string | null;
  thumbnail: string | null;
}

export interface Shot {
  shot_id: string;
  project_id: string;
  sequence_number: number;
  act_number: number;
  scene_id: string;
  character_ids: string[];
  shot_type: ShotType;
  camera_movement: CameraMovement;
  duration: number; // 4-12 seconds
  dialogue: string | null;
  dialogue_character: string | null;
  narration: string | null;
  action_description: string;
  emotion_tag: EmotionTag;
  generation_prompt: string;
  negative_prompt: string;
  transition_to_next: TransitionType;
  is_key_shot: boolean;
  dependencies: string[]; // shot_ids
  generation_status: GenerationStatus;
  generated_assets: GeneratedAssets;
  qc_score: number;
  qc_warnings: string[];
}

export interface Scene {
  scene_id: string;
  project_id: string;
  name: string;
  description: string;
  lighting: string;
  weather: string;
  time_of_day: string;
  mood: string;
  anchor_image: string | null;
  version: number;
}

export interface DependencyEdge {
  from: string;
  to: string;
  type: "frame_chain" | "narrative_order";
}

export interface EditHistoryEntry {
  edit_id: string;
  project_id: string;
  timestamp: number;
  action_type: string;
  target_entity: string;
  before_state: unknown;
  after_state: unknown;
  dirty_propagation: string[];
}
