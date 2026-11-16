import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { QaCase } from '../../lib/contracts';
import { QaFailure } from '../../lib/contracts';
import { copyMusic, cutMusic, pasteMusic } from '../../../../src/domain/clipboard';
import { contentToken } from '../../../../src/domain/commands/core';
import type { Command } from '../../../../src/domain/commands/core';
import { indexDocument } from '../../../../src/domain/event-time';
import { createHistory, executeCommand, undo } from '../../../../src/domain/history';
import { rationalQ } from '../../../../src/domain/rational';
import type { Selection } from '../../../../src/domain/selection';
import { parseScoreDocument } from '../../../../src/domain/validate';
import { fixtureDocument, mapEvents } from '../../../../tests/domain/fixtures';

export const run: QaCase = async context => {
  const doc = parseScoreDocument(fixtureDocument('unison-strings'));
  const first = [...indexDocument(doc).notes.values()][0];
  if (!first) throw new QaFailure('infrastructure', 'Missing input note');
  const selection: Selection = { kind: 'caret', scope: { trackIds: [], staffIds: [], voices: [1] },
    anchor: { eventId: first.location.event.id, startQ: rationalQ(0n), endQ: rationalQ(1n) },
    focus: { eventId: first.location.event.id, startQ: rationalQ(0n), endQ: rationalQ(1n) } };
  const initial = await createHistory(doc, selection);
  const changed = await executeCommand(initial, { expectedToken: contentToken(doc), edit: { kind: 'setFret', noteId: first.note.id, fret: 5 } });
  let history = undo(changed.history);
  const before = history;
  const beforeBytes = JSON.stringify(before);
  const commands: readonly { readonly name: string; readonly command: Command }[] = [
    { name: 'collision after an earlier batch edit', command: { expectedToken: contentToken(doc), edit: { kind: 'batch', edits: [
      { kind: 'setFret', noteId: first.note.id, fret: 9 },
      { kind: 'duration', eventId: first.location.event.id, duration: { base: 2, dots: 0, tupletIds: [] } },
    ] } } },
    { name: 'stale content token', command: { expectedToken: contentToken(changed.history.present.doc),
      edit: { kind: 'setFret', noteId: first.note.id, fret: 9 } } },
  ];
  const diagnostics: Record<string, unknown> = {};
  for (const item of commands) {
    context.log(`Attempt ${item.name}`);
    const result = await executeCommand(history, item.command);
    context.assert(result.kind === 'rejected', `${item.name}: explicit rejection`);
    context.assert(result.history === before && JSON.stringify(history) === beforeBytes, `${item.name}: document, selection, past and redo branch unchanged`);
    diagnostics[item.name] = result.diagnostics;
  }
  context.log('Attempt cut with failed clipboard write');
  const failedCut = await cutMusic({ current: () => history, commit: (expected, next) => {
    if (history !== expected) return false;
    history = next; return true;
  } }, () => Promise.reject(new Error('QA clipboard write denied')));
  context.assert(failedCut.kind === 'rejected' && history === before, 'Clipboard failure does not cut or publish history');
  context.assert(JSON.stringify(history) === beforeBytes, 'Clipboard failure preserves all document and selection bytes');
  diagnostics['clipboardFailure'] = failedCut.diagnostics;
  const silent = mapEvents(doc, e => ({ kind: 'rest', id: e.id, duration: e.duration }));
  const impossible = parseScoreDocument({ ...silent, tracks: silent.tracks.map(t => ({ ...t,
    staves: t.staves.map(s => ({ ...s, tuning: s.tuning.map(p => p + 12) })),
  })) });
  const paste = pasteMusic(impossible, { clipboard: copyMusic(doc, selection), expectedToken: contentToken(impossible),
    startQ: rationalQ(0n), voices: [{ source: first.location.voiceId, target: first.location.voiceId }] }, selection);
  context.assert(paste.kind === 'rejected' && paste.diagnostics.some(d => d.message.includes('revoicing')), 'Impossible corresponding-string pitch is rejected with revoicing choice');
  diagnostics['impossiblePaste'] = paste.diagnostics;
  const racedCut = await cutMusic({ current: () => history, commit: (expected, next) => {
    if (history !== expected) return false;
    history = next; return true;
  } }, () => {
    history = changed.history;
    return Promise.resolve();
  });
  context.assert(racedCut.kind === 'rejected' && history === changed.history, 'Cut refuses to delete a newer document after asynchronous clipboard write');
  context.assert(isDeepStrictEqual(before.present.doc, doc) && before.present.selection === selection, 'Original document and selection remain intact after every rejection');
  await writeFile(resolve(context.evidence, 'rejections.json'), JSON.stringify({ before, afterRejectedCommands: failedCut.history,
    diagnostics, concurrentEditPreserved: history, racedCutDiagnostics: racedCut.diagnostics }, null, 2));
  context.log('Saved rejection diagnostics and before/after history roots including redo branch');
};
