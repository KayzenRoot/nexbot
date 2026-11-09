import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('../src/client/api', () => ({ api: vi.fn() }));
import { PROVIDER_PRESETS, isOllama } from '../src/client/model-presets';
import { ModelSettings } from '../src/client/ModelSettings';
import { setLocalePreference } from '../src/client/i18n';

// Issue #43: configuring Ollama must be a preset in the model settings form,
// not a hand-edited .env — the key stays owner-typed and server-tested.
setLocalePreference('en');

it('ships presets for the default provider, OpenAI and local Ollama', () => {
  expect(PROVIDER_PRESETS.map((preset) => preset.id)).toEqual([
    'opencode',
    'openai',
    'ollama',
  ]);
  const ollama = PROVIDER_PRESETS.find((preset) => preset.id === 'ollama');
  expect(ollama?.baseUrl).toBe('http://host.docker.internal:11434/v1');
  expect(ollama?.model).toBeTruthy();
});

it('detects an Ollama base URL regardless of host spelling', () => {
  expect(isOllama('http://host.docker.internal:11434/v1')).toBe(true);
  expect(isOllama('http://localhost:11434/v1')).toBe(true);
  expect(isOllama('http://127.0.0.1:11434')).toBe(true);
  expect(isOllama('https://api.openai.com/v1')).toBe(false);
  expect(isOllama('https://opencode.ai/zen/go/v1')).toBe(false);
});

it('renders the presets in the model settings form', () => {
  const html = renderToStaticMarkup(<ModelSettings />);
  expect(html).toContain('Presets');
  expect(html).toContain('OpenCode Go');
  expect(html).toContain('OpenAI');
  expect(html).toContain('Ollama (local)');
});
