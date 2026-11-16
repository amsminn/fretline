import type { ScoreDocument } from '../../domain/document';
import { newId } from '../../domain/ids';
import { parsePackageParts } from '../../domain/project';
import type { SourceProvenance } from '../../domain/project';
import type { GpImport } from '../alphatab/import';
import { preservationEntries } from '../alphatab/compatibility';
import type { CompatibilityDiagnostic, CompatibilityReport } from '../alphatab/compatibility';

export function emptyScore(title: string): ScoreDocument {
  return { schemaVersion: 1, id: newId('score'),
    metadata: { title, subtitle: '', artist: '', album: '', words: '', music: '', copyright: '', instructions: '', notices: [] },
    measures: [], tracks: [], ties: [], tuplets: [], chords: [], lyrics: [], diagrams: [], automations: [], assets: [],
    layout: { systemBreaks: [], pageBreaks: [], hiddenTracks: [], scale: 1,
      stylesheet: { fontFamily: 'Bravura', fontSize: 12, showTab: true, showStandard: true, showChordDiagrams: true } } };
}
export async function importedProject(score: ScoreDocument, source: {
  readonly bytes: Uint8Array; readonly name: string; readonly extension: SourceProvenance['extension']; readonly format: string;
}, diagnostics: readonly CompatibilityDiagnostic[]): Promise<GpImport> {
  const original = Uint8Array.from(source.bytes);
  const digest = await crypto.subtle.digest('SHA-256', original);
  const sourceHash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  const report: CompatibilityReport = { inventoryVersion: 1, engineVersion: '1.9.0', format: source.format, sourceHash, diagnostics };
  return { parts: parsePackageParts({ project: { schemaVersion: 1, projectId: newId('project'), score, assets: [],
    source: { name: source.name, extension: source.extension, byteLength: original.length, sha256: sourceHash },
    preservation: preservationEntries(report) }, blobs: [{ sha256: sourceHash, bytes: original }] }), report };
}
export const loss = (feature: string, location: string, impact: string): CompatibilityDiagnostic => ({
  feature, location, status: 'unsupported', impact, alternative: '원본 또는 .fretline 프로젝트를 보존하고 별도 사본으로 교환하세요.',
});
