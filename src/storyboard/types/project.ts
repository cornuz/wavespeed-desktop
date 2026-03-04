/**
 * Core data models for the AI Storyboard system.
 * Maps to the full spec: Project, Character, Scene, Shot, DependencyGraph, EditHistory.
 */

export type ProjectMode = "lite" | "pro";
export type ProjectStatus =
  | "idle"
  | "creating"
  | "ready"
  | "generating"
  | "assembling"
  | "done";

export interface StyleProfile {
  visual_style: string;
  color_tone: string;
  aspect_ratio: "16:9" | "9:16" | "1:1";
  reference_images: string[];
}

export interface AudioProfile {
  bgm_style: string;
  narration_voice: string | null;
  sfx_density: "minimal" | "normal" | "rich";
}

export interface Project {
  project_id: string;
  name: string;
  mode: ProjectMode;
  status: ProjectStatus;
  style_profile: StyleProfile;
  audio_profile: AudioProfile;
  target_duration: number; // seconds
  created_at: number;
  updated_at: number;
}

export type CharacterStatus = "alive" | "dead" | "absent";

export interface AnchorImages {
  front: string | null;
  side: string | null;
  full_body: string | null;
}

export interface Character {
  character_id: string;
  project_id: string;
  name: string;
  visual_description: string;
  personality: string;
  role_in_story: string;
  voice_id: string | null;
  anchor_images: AnchorImages;
  status: CharacterStatus;
  version: number;
}
