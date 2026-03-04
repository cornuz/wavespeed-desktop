/**
 * Storyboard model configuration.
 * Defines which models to use for each generation task.
 * Uses the existing WaveSpeed apiClient for video/image generation.
 *
 * Model IDs are from the WaveSpeed API (see src/lib/smartFormConfig.ts):
 * - Video: Seedance V1.5 Pro (bytedance) — text-to-video-fast for speed
 * - Image: Seedream 4.5 (bytedance) — text-to-image for character/scene refs
 * - TTS: InfiniteTalk (wavespeed-ai) — audio generation
 */

export type ModelCategory = "video" | "image" | "tts" | "llm";

export interface ModelOption {
  id: string;
  name: string;
  category: ModelCategory;
  modelId: string;        // WaveSpeed API model_id
  description: string;
  defaultParams: Record<string, unknown>;
}

/** Default model selections for each category */
export const DEFAULT_MODELS: Record<ModelCategory, ModelOption> = {
  video: {
    id: "seedance-v1.5-pro-fast",
    name: "Seedance V1.5 Pro Fast",
    category: "video",
    modelId: "bytedance/seedance-v1.5-pro/text-to-video-fast",
    description: "快速文本生成视频，适合快速出片",
    defaultParams: {
      seed: 0,
    },
  },
  image: {
    id: "seedream-4.5",
    name: "Seedream 4.5",
    category: "image",
    modelId: "bytedance/seedream-v4.5",
    description: "高质量文本生成图片，用于角色和场景参考图",
    defaultParams: {
      image_size: "1024x1024",
      seed: 0,
    },
  },
  tts: {
    id: "infinitetalk",
    name: "InfiniteTalk",
    category: "tts",
    modelId: "wavespeed-ai/infinitetalk-fast",
    description: "快速语音合成",
    defaultParams: {},
  },
  llm: {
    id: "deepseek-chat",
    name: "DeepSeek Chat",
    category: "llm",
    modelId: "deepseek-chat",
    description: "大语言模型，用于剧本创作和意图解析",
    defaultParams: {
      temperature: 0.7,
      max_tokens: 8192,
    },
  },
};

/**
 * Image-to-video variant (when we have a reference image for the shot).
 */
export const VIDEO_I2V_MODEL: ModelOption = {
  id: "seedance-v1.5-pro-i2v-fast",
  name: "Seedance V1.5 Pro I2V Fast",
  category: "video",
  modelId: "bytedance/seedance-v1.5-pro/image-to-video-fast",
  description: "图片生成视频，用于有参考图的镜头",
  defaultParams: {
    seed: 0,
  },
};

/**
 * Image edit variant (when editing existing character/scene images).
 */
export const IMAGE_EDIT_MODEL: ModelOption = {
  id: "seedream-4.5-edit",
  name: "Seedream 4.5 Edit",
  category: "image",
  modelId: "bytedance/seedream-v4.5/edit",
  description: "图片编辑，用于修改角色和场景参考图",
  defaultParams: {
    image_size: "1024x1024",
    seed: 0,
  },
};

/** All available model options by category */
export const MODEL_OPTIONS: Record<ModelCategory, ModelOption[]> = {
  video: [
    DEFAULT_MODELS.video,
    VIDEO_I2V_MODEL,
    {
      id: "seedance-v1.5-pro-t2v",
      name: "Seedance V1.5 Pro (标准)",
      category: "video",
      modelId: "bytedance/seedance-v1.5-pro/text-to-video",
      description: "标准质量文本生成视频",
      defaultParams: { seed: 0 },
    },
  ],
  image: [
    DEFAULT_MODELS.image,
    IMAGE_EDIT_MODEL,
  ],
  tts: [
    DEFAULT_MODELS.tts,
    {
      id: "infinitetalk-normal",
      name: "InfiniteTalk (标准)",
      category: "tts",
      modelId: "wavespeed-ai/infinitetalk",
      description: "标准质量语音合成",
      defaultParams: {},
    },
  ],
  llm: [
    DEFAULT_MODELS.llm,
  ],
};
