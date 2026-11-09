import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { TaskActions } from '../src/client/TaskActions';
import { statusLabel } from '../src/client/TaskPresentation';
import type { Settings, Task } from '../src/shared/types';
import { setLocalePreference } from '../src/client/i18n';

// These assertions cover the English copy; pin it regardless of the machine.
setLocalePreference('en');
const settings: Settings = {
  name: 'Dot',
  paused: false,
  researchAllowed: true,
  memoryAllowed: true,
  appsAllowed: false,
};
const task: Task = {
  id: 'one',
  prompt: 'A recurring task',
  status: 'completed',
  intervalSeconds: 3600,
  nextRunAt: Date.now() + 3600000,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  error: null,
  lease: null,
  leaseUntil: null,
};
it('offers pause for a completed task waiting on its next scheduled run', () => {
  const html = renderToStaticMarkup(
    <TaskActions
      task={task}
      settings={settings}
      busy={false}
      onAction={() => {}}
      onSchedule={() => {}}
    />,
  );
  expect(html).toContain('Pause schedule');
  expect(html).toContain('Edit schedule');
});
it('offers resume for a paused task without claiming to be running', () => {
  const html = renderToStaticMarkup(
    <TaskActions
      task={{ ...task, status: 'paused' }}
      settings={settings}
      busy={false}
      onAction={() => {}}
      onSchedule={() => {}}
    />,
  );
  expect(html).toContain('Resume task');
  expect(html).not.toContain('Pause schedule');
});
it('shows a failed task that will retry on its own and lets the owner pause it', () => {
  const failed: Task = { ...task, status: 'failed', error: 'Run failed.' };
  const html = renderToStaticMarkup(
    <TaskActions
      task={failed}
      settings={settings}
      busy={false}
      onAction={() => {}}
      onSchedule={() => {}}
    />,
  );
  expect(html).toContain('Pause schedule');
  expect(html).toContain('Retry task');
  expect(statusLabel(failed)).toMatch(/^Failed, retrying at /);
});
it('keeps the plain Failed label and no pause control without a next run', () => {
  const failed: Task = { ...task, status: 'failed', nextRunAt: null };
  const html = renderToStaticMarkup(
    <TaskActions
      task={failed}
      settings={settings}
      busy={false}
      onAction={() => {}}
      onSchedule={() => {}}
    />,
  );
  expect(html).not.toContain('Pause schedule');
  expect(statusLabel(failed)).toBe('Failed');
});
it('renders the Brazilian Portuguese copy when that language is active', () => {
  setLocalePreference('pt-BR');
  const html = renderToStaticMarkup(
    <TaskActions
      task={{ ...task, status: 'completed', intervalSeconds: 300 }}
      settings={settings}
      busy={false}
      onAction={() => {}}
      onSchedule={() => {}}
    />,
  );
  expect(html).toContain('Pausar agendamento');
  expect(html).toContain('Editar agendamento');
  expect(html).not.toContain('Pause schedule');
});
it('adds the date to the retry label when the next run is not today', () => {
  const tomorrow: Task = {
    ...task,
    status: 'failed',
    nextRunAt: Date.now() + 86400000,
  };
  expect(statusLabel(tomorrow)).toContain(
    new Date(tomorrow.nextRunAt!).toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
    }),
  );
  const today: Task = {
    ...task,
    status: 'failed',
    nextRunAt: Date.now() + 60000,
  };
  expect(statusLabel(today)).not.toContain(
    new Date(today.nextRunAt!).toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
    }),
  );
});
