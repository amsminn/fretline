import { describe, expect, it } from 'vitest';
import { StorageError } from '../../src/domain/project';
import { menuSyncLimit, parseMenuAvailability } from '../../src/main/menu-sync';

const known = new Set(['view.palette', 'file.save']);

describe('menu availability IPC boundary', () => {
  it('accepts cataloged ids with boolean enabled flags', () => {
    expect(parseMenuAvailability([{ id: 'view.palette', enabled: true }, { id: 'file.save', enabled: false }], known))
      .toEqual([{ id: 'view.palette', enabled: true }, { id: 'file.save', enabled: false }]);
  });
  it.each([
    ['not an array', { id: 'view.palette', enabled: true }],
    ['unknown command id', [{ id: 'app.quit', enabled: true }]],
    ['non-boolean enabled', [{ id: 'view.palette', enabled: 'yes' }]],
    ['duplicate id', [{ id: 'view.palette', enabled: true }, { id: 'view.palette', enabled: false }]],
    ['extra prototype-less shape', [null]],
    ['oversized list', Array.from({ length: menuSyncLimit + 1 }, () => ({ id: 'view.palette', enabled: true }))],
  ])('rejects %s with a schema error', (_label, input) => {
    expect(() => parseMenuAvailability(input, known)).toThrow(StorageError);
  });
});
