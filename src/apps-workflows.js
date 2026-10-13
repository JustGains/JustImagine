// The Apps catalogue is shared by the server and the browser. Keep the labels
// here so a deep link, search result and job all name the same workflow.
// These stops and the tile treatment mirror JustGains' footer AppIconTile.
// A new app picks one palette entry and an icon; the renderer owns the shape.
const TILE_GRADIENTS = {
  gold: ['#FFCF3F', '#F0A400'],
  blue: ['#5B9BF8', '#2563EB'],
  coral: ['#FF8A63', '#F04E24'],
  cyan: ['#2BD4EE', '#0891B2'],
  purple: ['#977FFF', '#6249E8'],
  green: ['#4CD98B', '#1BA85D'],
  orange: ['#FF9E52', '#F5852F'],
  pink: ['#FB5477', '#E11D48'],
  ink: ['#52525B', '#27272A']
};

export const APPS = [
  { id: 'skin-editor', title: 'Skin Editor', summary: 'Refine skin texture while keeping the face natural.', category: 'Face', engine: 'image', input: 'image', icon: 'sparkle', gradient: TILE_GRADIENTS.pink },
  { id: 'retouch-portrait', title: 'Retouch Portrait', summary: 'Choose the exact portrait changes you want.', category: 'Face', engine: 'image', input: 'image', icon: 'portrait', gradient: TILE_GRADIENTS.purple },
  { id: 'change-hair', title: 'Change Hair', summary: 'Try a new cut, color, or both.', category: 'Face', engine: 'image', input: 'image', icon: 'hair', gradient: TILE_GRADIENTS.orange },
  { id: 'change-age', title: 'Change Age', summary: 'See a portrait at a different age.', category: 'Face', engine: 'image', input: 'image', icon: 'clock', gradient: TILE_GRADIENTS.blue },
  { id: 'change-expression', title: 'Change Expression', summary: 'Give a portrait a different expression.', category: 'Face', engine: 'image', input: 'image', icon: 'smile', gradient: TILE_GRADIENTS.gold },
  { id: 'image-editor', title: 'Image Editor', summary: 'Describe an edit in your own words.', category: 'Image', engine: 'image', input: 'image', icon: 'brush', gradient: TILE_GRADIENTS.ink },
  { id: 'expand-image', title: 'Expand Image', summary: 'Make room around the original image.', category: 'Image', engine: 'image', input: 'image', icon: 'expand', gradient: TILE_GRADIENTS.cyan },
  { id: 'remove-object', title: 'Remove Object', summary: 'Erase a person or object and fill the space.', category: 'Image', engine: 'image', input: 'image', icon: 'eraser', gradient: TILE_GRADIENTS.coral },
  { id: 'remove-light', title: 'Remove Light', summary: 'Soften glare, harsh shadows, or blown highlights.', category: 'Image', engine: 'image', input: 'image', icon: 'sun', gradient: TILE_GRADIENTS.gold },
  { id: 'remove-background', title: 'Remove Background', summary: 'Cut the background out of a whole batch of images at once.', category: 'Image', engine: 'rmbg', input: 'images', icon: 'cutout', gradient: TILE_GRADIENTS.blue },
  { id: 'upscaler', title: 'Upscaler', summary: 'Make an image larger with a clean, sharp finish.', category: 'Image', engine: 'local-image', input: 'image', icon: 'upscale', gradient: TILE_GRADIENTS.green },
  { id: 'video-generator', title: 'Video Generator', summary: 'Turn a scene idea or image into a clip.', category: 'Video', engine: 'video', input: 'optional-image', icon: 'video', gradient: TILE_GRADIENTS.blue },
  { id: 'video-remix', title: 'Video Remix', summary: 'Change the subject in a clip and keep its original sound.', category: 'Video', engine: 'scene-video', input: 'video', icon: 'swap', gradient: TILE_GRADIENTS.coral },
  { id: 'video-trim', title: 'Video Trim', summary: 'Keep the exact part of a clip you need.', category: 'Video', engine: 'local-video', input: 'video', icon: 'scissors', gradient: TILE_GRADIENTS.purple },
  { id: 'ugc-audio-fixer', title: 'UGC Audio Fixer', summary: 'Clean up speech and level out a clip’s sound.', category: 'Video', engine: 'local-video', input: 'video', icon: 'audio', gradient: TILE_GRADIENTS.cyan },
  { id: 'vectorize', title: 'Vectorize', summary: 'Draw a simple, editable SVG from a description.', category: 'Image', engine: 'vector', input: 'none', icon: 'vector', gradient: TILE_GRADIENTS.pink }
];

export const APP_BY_ID = Object.fromEntries(APPS.map((app) => [app.id, app]));
// Apps that run only where their local tool is installed; the catalogue leaves
// them out everywhere else.
export const OPTIONAL_ENGINES = ['rmbg'];
export const RMBG_MODEL = 'BRIA RMBG-2.0';
// One run's images. Each is uploaded on its own, so this bounds a batch's
// temporary disk and its single download.
export const RMBG_MAX_IMAGES = 200;
export const APP_CATEGORIES = ['All', 'Image', 'Video', 'Face'];

const clean = (value, max = 800) => String(value ?? '').trim().slice(0, max);
const oneOf = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;

export function imageAppPrompt(id, values = {}) {
  const preserve = 'Use the attached image as the source. Keep the person, objects, composition, and recognizable details the same except for the requested edit. Return one finished image, without a collage, border, caption, or before-and-after split.';
  const strength = oneOf(values.strength, ['subtle', 'balanced', 'strong'], 'balanced');
  switch (id) {
    case 'skin-editor': {
      const finish = oneOf(values.finish, ['natural', 'studio', 'texture'], 'natural');
      const treatment = {
        natural: 'Even out distracting blemishes and uneven tones while retaining pores, fine lines, and real skin texture.',
        studio: 'Apply a polished editorial skin retouch with balanced color and soft transitions. Keep believable skin texture.',
        texture: 'Restore convincing fine skin texture and detail without changing facial features.'
      }[finish];
      return `${preserve} ${treatment} The retouch should be ${strength}.`;
    }
    case 'retouch-portrait': {
      const changes = Array.isArray(values.changes) ? values.changes.filter((v) => ['blemishes', 'shine', 'scars', 'freckles', 'under-eyes', 'face-shape', 'double-chin'].includes(v)) : [];
      if (!changes.length) throw new Error('Pick at least one portrait change.');
      const instructions = {
        blemishes: 'reduce temporary blemishes and acne', shine: 'reduce oily shine', scars: 'soften visible scars',
        freckles: 'soften freckles', 'under-eyes': 'lighten dark under-eye areas', 'face-shape': 'gently refine the face shape',
        'double-chin': 'gently reduce the appearance of a double chin'
      };
      return `${preserve} Please ${changes.map((v) => instructions[v]).join('; ')}. Make the changes ${strength}, and keep the person recognizable.`;
    }
    case 'change-hair': {
      const color = clean(values.color, 80);
      const style = clean(values.style, 80);
      if (!color && !style) throw new Error('Choose a hair color, style, or both.');
      return `${preserve} Change only the hair${color ? ` to ${color}` : ''}${style ? ` with a ${style} style` : ''}. Keep the face, pose, clothes, and background unchanged. Make the hairline and lighting believable.`;
    }
    case 'change-age': {
      const age = Number(values.age);
      if (!Number.isInteger(age) || age < 5 || age > 90) throw new Error('Choose an age from 5 to 90.');
      return `${preserve} Show the same person at about age ${age}. Change age-related facial details, hair, and skin naturally while preserving their identity, expression, pose, clothing, and background.`;
    }
    case 'change-expression': {
      const expression = oneOf(values.expression, ['smiling', 'laughing', 'sad', 'angry', 'surprised', 'neutral'], 'smiling');
      return `${preserve} Change only the facial expression to ${expression}. Keep identity, hairstyle, pose, clothing, background, and lighting consistent. Make the expression natural.`;
    }
    case 'image-editor': {
      const edit = clean(values.prompt, 1600);
      if (!edit) throw new Error('Describe the edit you want.');
      return `${preserve} Edit request: ${edit}`;
    }
    case 'expand-image': {
      const ratio = oneOf(values.ratio, ['1:1', '4:3', '3:4', '16:9', '9:16'], '16:9');
      const fill = clean(values.prompt, 600);
      return `${preserve} Outpaint the canvas to a ${ratio} aspect ratio. The transparent margins in the reference are missing scene: fill them. Keep the original image intact near the center and invent only the surroundings needed to fill the new canvas.${fill ? ` For the new space: ${fill}` : ' Continue the scene naturally, matching perspective, light, and texture.'}`;
    }
    case 'remove-object': {
      const target = clean(values.prompt, 600);
      if (!target) throw new Error('Describe what should be removed.');
      return `${preserve} Remove ${target}. Fill the cleared area using the surrounding scene. Leave everything else in place.`;
    }
    case 'remove-light': {
      const issue = oneOf(values.issue, ['glare', 'shadows', 'highlights', 'mixed'], 'glare');
      const treatments = {
        glare: 'remove distracting glare and reflections', shadows: 'soften harsh shadows',
        highlights: 'recover blown highlights where possible', mixed: 'balance uneven or mixed lighting'
      };
      return `${preserve} ${treatments[issue]}. Match the light across the scene and preserve the original colors and details.`;
    }
    default: throw new Error('Unknown image workflow.');
  }
}

export function imageAppLabel(id, values = {}) {
  const app = APP_BY_ID[id];
  if (!app) throw new Error('Unknown image workflow.');
  const detail = id === 'skin-editor' ? values.finish
    : id === 'retouch-portrait' ? (Array.isArray(values.changes) ? values.changes.join(', ') : '')
    : id === 'change-hair' ? [values.color, values.style].filter(Boolean).join(', ')
    : id === 'change-age' ? `age ${values.age}`
    : id === 'change-expression' ? values.expression
    : id === 'expand-image' ? values.ratio
    : id === 'remove-light' ? values.issue
    : values.prompt;
  return `${app.title}${detail ? ` · ${clean(detail, 100)}` : ''}`;
}

export function videoAppPrompt(values = {}) {
  const prompt = clean(values.prompt, 1600);
  if (!prompt) throw new Error('Describe the clip you want to make.');
  return prompt;
}

// Reference-aware models go first. Each choice is checked against the live
// catalogue and configured keys; a typed model never silently changes provider.
const IMAGE_PREFERRED = [
  ['openrouter', 'google/gemini-3.1-flash-image'],
  ['openrouter', 'openai/gpt-image-2.5-flare'],
  ['openlux', 'gemini-3.1-flash-image'],
  ['openlux', 'gpt-image-2-c'],
  ['yunwu', 'gemini-3.1-flash-image'],
  ['openai', 'gpt-image-1']
];

export const supportsImageAppEditing = (model) => /gemini.*image|flash.image|gpt[\w.-]*image|seedream/i.test(String(model?.id || '')) && !/dall-e/i.test(String(model?.id || ''));

export function chooseImageAppModel(apis, hasKey, selection = {}) {
  if (selection.api || selection.model) {
    const api = apis.find((a) => a.id === selection.api);
    const model = api?.models?.find((m) => m.id === selection.model);
    if (!api || !model || !hasKey(api.id)) throw new Error('That image model is unavailable. Choose another model or add its key in Settings.');
    if (!supportsImageAppEditing(model)) throw new Error('This model cannot edit a source image. Choose a reference-aware model.');
    return { api, model };
  }
  for (const [apiId, modelId] of IMAGE_PREFERRED) {
    const api = apis.find((a) => a.id === apiId);
    const model = api?.models?.find((m) => m.id === modelId);
    if (model && hasKey(apiId)) return { api, model };
  }
  for (const api of apis) {
    if (!hasKey(api.id)) continue;
    const model = api.models?.find(supportsImageAppEditing);
    if (model) return { api, model };
  }
  return null;
}

export function chooseVideoAppModel(models, hasKey, selection = {}) {
  if (selection.model) {
    const model = models.find((m) => m.id === selection.model && (m.api || 'openrouter') === (selection.api || 'openrouter'));
    if (!model || !hasKey(model.api || 'openrouter')) throw new Error('That video model is unavailable. Choose another model or add its key in Settings.');
    return model;
  }
  const ready = models.filter((m) => hasKey(m.api || 'openrouter'));
  return ready.find((m) => /veo-3\.1|seedance-2/i.test(m.id)) || ready[0] || null;
}
