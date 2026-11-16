import { strFromU8, unzipSync } from 'fflate';
import { parseManifest, parseProject } from '../../../../src/domain/project';
import { applyCommand, contentToken } from '../../../../src/domain/commands/core';
import { assertNever, DomainError } from '../../../../src/domain/diagnostics';
import type { ScoreDocument } from '../../../../src/domain/document';
import type { ScoreHit } from '../../../../src/renderer/score/overlay';

/** Fixed, bundled QA fixture; never a general file-opening bypass. */
export async function loadPerfFixture(signal: AbortSignal): Promise<{
  readonly score: ScoreDocument; readonly sha256: string; readonly attacks: number;
}> {
  const response = await fetch(new URL('../../../../tests/fixtures/projects/perf.fretline', import.meta.url), { signal });
  if (!response.ok) throw new TypeError(`Performance fixture load failed: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const entries = unzipSync(bytes);
  const manifestBytes = entries['manifest.json'];
  const scoreBytes = entries['score.json'];
  if (!manifestBytes || !scoreBytes || Object.keys(entries).length !== 2) throw new TypeError('Expected asset-free performance project');
  const manifest = parseManifest(JSON.parse(strFromU8(manifestBytes)));
  const digest = async (input: Uint8Array): Promise<string> => {
    const buffer = new Uint8Array(input).buffer;
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), byte => byte.toString(16).padStart(2, '0')).join('');
  };
  if (await digest(scoreBytes) !== manifest.scoreSha256) throw new TypeError('Performance score checksum mismatch');
  const { revision, scoreSha256, contentHash, manifestSha256, ...metadata } = manifest;
  void revision; void scoreSha256; void contentHash; void manifestSha256;
  const project = parseProject({ ...metadata, score: JSON.parse(strFromU8(scoreBytes)) });
  const attacks = project.score.tracks.flatMap(track => track.staves.flatMap(staff => staff.voices.flatMap(voice =>
    voice.bars.flatMap(bar => bar.kind === 'active' ? bar.events.filter(event => event.kind === 'noteGroup') : [])))).length;
  if (project.score.tracks.length !== 16 || project.score.measures.length !== 256 || attacks !== 10000) {
    throw new RangeError('Performance project must contain 16 tracks, 256 bars and 10000 attacks');
  }
  return { score: project.score, sha256: await digest(bytes), attacks };
}

export function editPerfFret(document: ScoreDocument, hit: ScoreHit, fret: number): ScoreDocument {
  if (!hit.noteId) throw new TypeError('Click a fretted note before editing');
  const endpoint = { eventId: hit.eventId, startQ: hit.startQ, endQ: hit.endQ };
  const result = applyCommand(document, { expectedToken: contentToken(document),
    edit: { kind: 'setFret', noteId: hit.noteId, fret } },
  { kind: 'caret', scope: { trackIds: [hit.trackId], staffIds: [hit.staffId], voices: [1] }, anchor: endpoint, focus: endpoint });
  switch (result.kind) {
    case 'applied': return result.nextDoc;
    case 'rejected': throw new DomainError(result.diagnostics);
    default: return assertNever(result);
  }
}
