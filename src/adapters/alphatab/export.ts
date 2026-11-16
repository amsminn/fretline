import { exporter } from '@coderline/alphatab/core';
import type { DocumentToken, PackageParts } from '../../domain/project';
import { projectScore } from './project';
import { preflightExport } from './preflight';
import type { ExportPreflight, ScoreExportFormat } from './preflight';
import { assertNever } from '../../domain/diagnostics';
import { rationalQ } from '../../domain/rational';
import type { ExportBridge, ExportFormat, ExportResult } from '../../preload/export-contract';

export type ExportTarget = ScoreExportFormat | 'original';
export type ExportWriteResult = ExportResult | { readonly kind: 'review-required' | 'blocked' };
export class ScoreExportError extends Error {
  constructor(readonly code: 'SOURCE_MISSING' | 'SOURCE_CHECKSUM' | 'RHYTHM_LIMIT', message: string) {
    super(message);
    this.name = 'ScoreExportError';
  }
}

/** A detached snapshot owns its encoder; confirmation always applies to exactly this report and these bytes. */
export class PreparedExport {
  constructor(readonly report: ExportPreflight, private readonly output: {
    readonly format: ExportFormat;
    readonly suggestedName: string;
    readonly encode: () => Uint8Array;
  }) {}

  async write(bridge: Pick<ExportBridge, 'exportArtifact'>, request: {
    readonly documentToken: DocumentToken;
    readonly acknowledgeLoss: boolean;
  }): Promise<ExportWriteResult> {
    if (this.report.diagnostics.some(item => item.impact === 'blocked')) return { kind: 'blocked' };
    if (this.report.diagnostics.length && !request.acknowledgeLoss) return { kind: 'review-required' };
    return bridge.exportArtifact({ documentToken: request.documentToken, format: this.output.format,
      suggestedName: this.output.suggestedName, bytes: this.output.encode() });
  }
}

/** Original extraction is a separate byte-exact action, never an export of the edited engine score. */
export async function prepareExport(parts: PackageParts, target: ExportTarget): Promise<PreparedExport> {
  switch (target) {
    case 'original': {
      const source = parts.project.source;
      const blob = source && parts.blobs.find(blob => blob.sha256 === source.sha256);
      if (!source || !blob) throw new ScoreExportError('SOURCE_MISSING', '보존된 원본 파일이 없습니다.');
      const bytes = Uint8Array.from(blob.bytes);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      if (bytes.length !== source.byteLength || hash !== source.sha256) throw new ScoreExportError('SOURCE_CHECKSUM', '보존된 원본의 길이 또는 체크섬이 일치하지 않습니다. 원본 추출을 중단했습니다.');
      return new PreparedExport({ engineVersion: '1.9.0', target, diagnostics: [] }, {
        format: 'source-original', suggestedName: source.name, encode: () => bytes.slice(),
      });
    }
    case 'gp': case 'alphatex': {
      const document = parts.project.score;
      const projection = projectScore(document);
      const report = preflightExport(parts.project, target, projection);
      // Exporters omit overrideDisplayDuration. Encode exact authored time as one
      // composite tuplet ratio, including nested/cross-bar groups and short glyphs.
      const tuplets = new Map(document.tuplets.map(tuplet => [tuplet.id, tuplet]));
      for (const track of document.tracks) for (const staff of track.staves) for (const voice of staff.voices) for (const bar of voice.bars) {
        switch (bar.kind) {
          case 'inactive': break;
          case 'active':
            for (const event of bar.events) {
              if (event.duration === 'fullMeasure') continue;
              const beat = projection.identity.events.get(event.id);
              if (!beat) throw new RangeError(`Missing export beat ${event.id}`);
              let numerator = BigInt(event.duration.base);
              let denominator = BigInt(Math.min(event.duration.base, 256));
              for (const id of event.duration.tupletIds) {
                const tuplet = tuplets.get(id);
                if (!tuplet) throw new RangeError(`Missing export tuplet ${id}`);
                numerator *= BigInt(tuplet.actual);
                denominator *= BigInt(tuplet.normal);
              }
              const ratio = rationalQ(numerator, denominator);
              if (BigInt(ratio.n) > BigInt(Number.MAX_SAFE_INTEGER) || BigInt(ratio.d) > BigInt(Number.MAX_SAFE_INTEGER)) {
                throw new ScoreExportError('RHYTHM_LIMIT', '출력 라이브러리의 잇단음표 비율 범위를 넘었습니다. 리듬을 단순화한 사본으로 출력하세요.');
              }
              beat.tupletNumerator = Number(ratio.n);
              beat.tupletDenominator = Number(ratio.d);
            }
            break;
          default: assertNever(bar);
        }
      }
      return new PreparedExport(report, { format: target, suggestedName: document.metadata.title || 'Untitled', encode: () => {
        switch (target) {
          case 'gp': return new exporter.Gp7Exporter().export(projection.score, projection.settings);
          case 'alphatex': return new exporter.AlphaTexExporter().export(projection.score, projection.settings);
          default: return assertNever(target);
        }
      } });
    }
    default: return assertNever(target);
  }
}
