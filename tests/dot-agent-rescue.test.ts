import { afterEach, expect, it, vi } from 'vitest';
import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';
import { Observable, Subject, lastValueFrom, toArray } from 'rxjs';
import { SetupTelemetry } from '../src/server/setup-telemetry.js';
import { DotAgent } from '../src/server/dot-agent.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { completion } from './fixtures/model-stream.js';

// DeepSeek reasoning models sometimes stream the whole final answer on
// reasoning_content with an empty content (issue #114). These tests pin the
// one-shot rescue: the run's finished event is held back, the model is asked
// once for the answer as visible text, and the outcome is still delivered
// when the rescue itself fails.
const inner = vi.hoisted(() => ({
  configure:
    vi.fn<
      (
        options: ConstructorParameters<
          typeof import('@copilotkit/runtime/v2').BuiltInAgent
        >[0],
      ) => void
    >(),
  run: vi.fn<(input: RunAgentInput) => Observable<BaseEvent>>(),
  abortRun: vi.fn(),
}));
vi.mock('@copilotkit/runtime/v2', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@copilotkit/runtime/v2')>();
  return {
    ...original,
    BuiltInAgent: class {
      constructor(
        options: ConstructorParameters<typeof original.BuiltInAgent>[0],
      ) {
        inner.configure(options);
      }
      run = inner.run;
      abortRun = inner.abortRun;
    },
  };
});
const databases: Array<{ close(): void }> = [];
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  vi.restoreAllMocks();
  inner.configure.mockClear();
});

function fixture() {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  databases.push(store, workspace);
  const dot = workspace.dots()[0];
  workspace.bindThread('thread', dot.id, 'Test');
  const telemetry = new SetupTelemetry(store, {}, async () => {});
  const agent = new DotAgent(
    store,
    workspace,
    {
      apiKey: 'fixture',
      model: 'fixture',
      baseUrl: 'https://unused.invalid',
      runtimeUrl: '',
      voiceName: 'marin',
      slackUsers: [],
    },
    dot.id,
    false,
    telemetry,
  );
  const input: RunAgentInput = {
    threadId: 'thread',
    runId: 'run',
    state: {},
    messages: [],
    tools: [],
    context: [],
    forwardedProps: {},
  };
  return { agent, input };
}

const reasoningDelta = (text: string): BaseEvent =>
  ({
    type: EventType.REASONING_MESSAGE_CONTENT,
    messageId: 'reason-1',
    delta: text,
  }) as BaseEvent;
const finished = (): BaseEvent =>
  ({
    type: EventType.RUN_FINISHED,
    threadId: 'thread',
    runId: 'run',
  }) as BaseEvent;
const textOf = (events: BaseEvent[]) =>
  events
    .filter((event) => event.type === EventType.TEXT_MESSAGE_CHUNK)
    .map((event) => (event as unknown as { delta: string }).delta)
    .join('');

it('rescues a reasoning-only run by re-asking for the answer as text', async () => {
  const f = fixture();
  const subject = new Subject<BaseEvent>();
  inner.run.mockReturnValue(subject);
  const bodies: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    bodies.push(String(init?.body));
    return completion({
      role: 'assistant',
      content: 'Resposta final visível.',
    });
  });
  const pending = lastValueFrom(f.agent.run(f.input).pipe(toArray()));
  subject.next(
    reasoningDelta(
      'Analisei as 200 velas de 1h: flush até 74808 e compressão em 75400-76200. Funding levemente positivo.',
    ),
  );
  subject.next(finished());
  subject.complete();
  const events = await pending;
  expect(textOf(events)).toBe('Resposta final visível.');
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  // Exactly one rescue request, carrying the instruction and the draft.
  expect(bodies).toHaveLength(1);
  const sent = JSON.parse(bodies[0]) as {
    messages: Array<{ role: string; content: string }>;
  };
  const last = sent.messages.at(-1);
  expect(last?.role).toBe('user');
  expect(last?.content).toContain('hidden reasoning');
  expect(last?.content).toContain('compressão em 75400-76200');
});

it('rescues a run whose text was only a preamble', async () => {
  const f = fixture();
  const subject = new Subject<BaseEvent>();
  inner.run.mockReturnValue(subject);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    completion({ role: 'assistant', content: 'Análise completa em texto.' }),
  );
  const pending = lastValueFrom(f.agent.run(f.input).pipe(toArray()));
  subject.next({
    type: EventType.TEXT_MESSAGE_CHUNK,
    role: 'assistant',
    messageId: 'm1',
    delta: 'Vou puxar os dados.',
  } as BaseEvent);
  subject.next(reasoningDelta('r'.repeat(600)));
  subject.next(finished());
  subject.complete();
  const events = await pending;
  expect(textOf(events)).toBe('Vou puxar os dados.Análise completa em texto.');
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
});

it('does not rescue a run that already answered in text', async () => {
  const f = fixture();
  const subject = new Subject<BaseEvent>();
  inner.run.mockReturnValue(subject);
  const fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('must not be called'));
  const pending = lastValueFrom(f.agent.run(f.input).pipe(toArray()));
  subject.next({
    type: EventType.TEXT_MESSAGE_CHUNK,
    role: 'assistant',
    messageId: 'm1',
    delta: 'Resposta completa e visível para o usuário.',
  } as BaseEvent);
  subject.next(finished());
  subject.complete();
  const events = await pending;
  expect(textOf(events)).toBe('Resposta completa e visível para o usuário.');
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('still finishes when the rescue turn fails', async () => {
  const f = fixture();
  const subject = new Subject<BaseEvent>();
  inner.run.mockReturnValue(subject);
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('provider down'));
  const pending = lastValueFrom(f.agent.run(f.input).pipe(toArray()));
  subject.next(
    reasoningDelta(
      'Rascunho longo o bastante para disparar o resgate, mas o provedor vai falhar.',
    ),
  );
  subject.next(finished());
  subject.complete();
  const events = await pending;
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  expect(textOf(events)).toBe('');
}, 15000);
