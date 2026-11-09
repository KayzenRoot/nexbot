/**
 * Provider presets for the model settings form. A preset only fills the form:
 * the key is still typed by the owner and tested by the server before saving,
 * so a preset can never persist a provider nobody verified.
 *
 * Ollama answers on the host, not inside the container, so the Docker install
 * needs `host.docker.internal`; `npm run dev` users switch to `localhost`.
 */
export interface ProviderPreset {
  id: 'opencode' | 'openai' | 'ollama';
  baseUrl: string;
  model: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'opencode',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    model: 'deepseek-v4.1-flash',
  },
  { id: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  {
    id: 'ollama',
    baseUrl: 'http://host.docker.internal:11434/v1',
    model: 'llama3.1:8b',
  },
];

/** True when the base URL points at a local Ollama server. */
export function isOllama(baseUrl: string): boolean {
  return /:11434(\/|$)/.test(baseUrl.trim());
}
