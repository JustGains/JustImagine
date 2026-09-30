import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createImagineCli, SKILL_ID, skillSource, skillTarget, LOCAL_ROOT, localRoot } from './justimagine.js';

test('live refresh retains explicitly supported image models and prefers live pricing', async () => {
  let selected;
  const live = { id: 'google/gemini-3.1-flash-image', name: 'Live name', pricing: { perImage: 0.1 } };
  let liveModels = [live];
  const cli = createImagineCli({
    catalogues: {
      loadOpenRouterImageModels: async () => liveModels,
      loadOpenRouterVideoModels: async () => [],
      loadDesignArena: async () => null
    },
    ui: {
      isInteractive: true,
      select: async ({ choices }) => {
        selected = choices.find((choice) => choice.value.id === 'openrouter').value;
        return { value: selected };
      },
      // Stop at the key prompt so this catalogue check never starts a server.
      promptHidden: async () => ''
    },
    state: { lastModelFor: () => null }
  });
  await cli.runJustImagine({ config: { imageApis: [{ id: 'openrouter', keyEnv: '' }] } });
  expect(selected.models.some((model) => model.id === 'openai/gpt-image-2.5-flare')).toBe(true);
  expect(selected.models.filter((model) => model.id === live.id)).toEqual([{ ...live, via: 'chat' }]);
  // Older host catalogue adapters classify every image model as chat-routed.
  // A later listing must not send Flare back to the unsupported chat endpoint.
  liveModels = [{ id: 'openai/gpt-image-2.5-flare', via: 'chat', pricing: { perImage: 0.08 } }];
  await cli.runJustImagine({ config: { imageApis: [{ id: 'openrouter', keyEnv: '' }] } });
  const flare = selected.models.find((model) => model.id === 'openai/gpt-image-2.5-flare');
  expect(flare.via).toBe('images');
  expect(flare.pricing.perImage).toBe(0.08);
});

// ---------- the packaged skill ----------

test('the generate-images-videos skill ships inside the package', () => {
  const file = path.join(skillSource(), 'SKILL.md');
  expect(fs.existsSync(file)).toBe(true);

  const text = fs.readFileSync(file, 'utf8');
  // Claude Code reads the frontmatter to decide whether the skill applies, so
  // the name has to match the directory and the description has to say enough
  // to be matched against a request.
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  expect(front).not.toBe(null);
  expect(front[1]).toContain(`name: ${SKILL_ID}`);
  expect(front[1]).toMatch(/description: .{120,}/);

  // The routes it teaches must be the ones the server actually serves.
  for (const route of ['/api/batch', '/api/jobs?ids=', '/api/models', '/api/context', '/api/generate']) {
    expect(text).toContain(route);
  }
  // And the instructions a script cannot infer from the routes alone.
  expect(text).toContain('wait');
  expect(text).toMatch(/8791/);
});

test('the package declares the skill directory as shipped', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(skillSource(), '..', '..', 'package.json'), 'utf8'));
  expect(pkg.files).toContain('skills');
});

test('the skill installs into the project by default, the home directory on demand', () => {
  expect(skillTarget()).toBe(path.join(process.cwd(), '.claude', 'skills', SKILL_ID));
  expect(skillTarget({ global: true })).toBe(path.join(os.homedir(), '.claude', 'skills', SKILL_ID));
  // An explicit directory is taken as given — this is how a non-Claude harness
  // puts the instructions wherever it keeps them.
  expect(skillTarget({ dir: 'D:/agents/notes' })).toBe(path.resolve('D:/agents/notes'));
  // --global wins nothing over an explicit path.
  expect(skillTarget({ global: true, dir: 'D:/agents/notes' })).toBe(path.resolve('D:/agents/notes'));
});

// ---------- gallery roots ----------

test('a gallery belongs to the directory it was made in', () => {
  expect(LOCAL_ROOT).toEqual(['.justimagine']);
  expect(localRoot('D:/work/site')).toBe(path.join('D:/work/site', '.justimagine'));
});
