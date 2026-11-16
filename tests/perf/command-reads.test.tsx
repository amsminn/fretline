import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ServicesContext, useCommands } from '../../src/renderer/shell/services';
import { CommandRegistry } from '../../src/renderer/commands/registry';
import { commandDefinitions } from '../../src/renderer/commands/catalog';
import { setLanguage } from '../../src/renderer/i18n/language';
import { services } from '../ui/shell-harness';

afterEach(() => { cleanup(); vi.restoreAllMocks(); setLanguage('ko'); });

function CommandReads({ revision }: { readonly revision: number }) {
  useCommands('toolbar', ['sound.playPause']);
  useCommands('toolbar', ['sound.loop']);
  useCommands('toolbar', ['file.save']);
  useCommands('toolbar', ['edit.undo']);
  return <span data-revision={revision} />;
}

it('does no live DOM queries when unchanged command context is read by multiple rendered surfaces', async () => {
  const context = services();
  const view = render(<ServicesContext.Provider value={context}><CommandReads revision={0} /></ServicesContext.Provider>);
  await Promise.resolve();
  const queries = vi.spyOn(document, 'querySelector');

  view.rerender(<ServicesContext.Provider value={context}><CommandReads revision={1} /></ServicesContext.Provider>);

  expect(queries).toHaveBeenCalledTimes(0);
});

it('refreshes command availability without resolving unchanged localized labels again', () => {
  const definition = commandDefinitions.find(command => command.id === 'file.save');
  if (!definition) throw new TypeError('Save command is missing');
  const labels = vi.spyOn(definition, 'label', 'get');
  const registry = new CommandRegistry();
  let enabled = false;
  registry.register(definition.id, { execute: () => undefined, enabled: () => enabled });
  registry.present('toolbar', { context: 'editing' });
  labels.mockClear();

  enabled = true;
  registry.changed();
  const commands = registry.present('toolbar', { context: 'editing' });

  expect(commands[0]?.enabled).toBe(true);
  expect(labels).toHaveBeenCalledTimes(0);
  setLanguage('en');
  expect(registry.present('toolbar', { context: 'editing' })[0]?.tooltip).toBe('Save (Meta+s)');
  setLanguage('ko');
  expect(registry.present('toolbar', { context: 'editing' })[0]?.tooltip).toBe('저장 (Meta+s)');
});
