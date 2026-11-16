import type { ProjectV1 } from '../../domain/project';
import type { ScoreProjection } from './project';
import { assertNever } from '../../domain/diagnostics';
import { compareQ, rationalQ } from '../../domain/rational';

export type ScoreExportFormat = 'gp' | 'alphatex';
export type ExportDiagnostic = {
  /** Stable machine key (test ids, data attributes); never shown as text. */
  readonly feature: string;
  /** Short user-facing Korean heading. */
  readonly title: string;
  readonly location: string;
  readonly impact: 'omitted' | 'approximate' | 'blocked';
  readonly detail: string;
  readonly alternative: string;
};
export type ExportPreflight = {
  readonly engineVersion: '1.9.0';
  readonly target: ScoreExportFormat | 'original';
  readonly diagnostics: readonly ExportDiagnostic[];
};

export const preflightAlternative = '정확한 편집 정보는 .fretline으로 저장하세요. 가져온 원본은 별도로 그대로 추출할 수 있습니다.';
const titles: Readonly<Record<string, string>> = {
  'gp.container.version': '파일 버전', 'audio.sounds': '음색', 'layout.stylesheet': '글꼴·배치 설정', 'layout.systemBreaks': '수동 줄 바꿈',
  'projection.mapping': '엔진 변환 제한', 'rhythm.tuplet.structure': '잇단음표 구조', 'rhythm.glyph': '매우 짧은 음표', 'rhythm.spacer': '보이지 않는 간격',
  'tempo.precision': '소수점 템포', 'navigation.target': '진행 기호 대상', 'measure.actualSpan': '못갖춘마디·자유 박자', 'audio.backing': '반주 오디오',
  'audio.masterEqualizer': '마스터 EQ', 'audio.trackEqualizer': '트랙 EQ', 'mixer.precision': '볼륨·팬 정밀도', 'scale.structure': '스케일',
  'automation.sustain': '서스테인 페달 자동화', 'automation.volume': '볼륨 자동화', 'automation.pan': '팬 자동화', 'automation.expression': '익스프레션 자동화',
  'automation.pitchBend': '피치 벤드 자동화', 'technique.tremoloBar': '트레몰로 바', 'technique.bend': '벤드', 'technique.trill.speed': '트릴 속도',
  'technique.slide.target': '슬라이드 대상 음', 'note.audio': '음표 오디오 설정', 'container.private-fields': '원본의 비공개 정보',
};
const titleOf = (feature: string): string => titles[feature] ?? '가져온 원본의 정보';

/** This is a target inventory, not a claim that a quiet engine import was lossless. */
export function preflightExport(project: ProjectV1, target: ScoreExportFormat, projection: ScoreProjection): ExportPreflight {
  const diagnostics: ExportDiagnostic[] = [];
  const add = (feature: string, location: string, loss: Pick<ExportDiagnostic, 'impact' | 'detail'>): void => {
    diagnostics.push({ feature, title: titleOf(feature), location, ...loss, alternative: preflightAlternative });
  };
  const omitted = (feature: string, location: string, detail: string): void => add(feature, location, { impact: 'omitted', detail });
  const approximate = (feature: string, location: string, detail: string): void => add(feature, location, { impact: 'approximate', detail });
  const score = project.score;
  if (target === 'gp') approximate('gp.container.version', '파일 형식',
    '.gp 형식 8.1.3으로 저장됩니다. 형식 7까지만 읽는 프로그램에서는 열리지 않을 수 있습니다.');
  approximate('audio.sounds', '악보 전체', '출력 파일은 기본 GM 악기 음색을 씁니다. 원본 파일의 전용 음색과 이펙트는 다릅니다.');
  omitted('layout.stylesheet', '악보 전체', '글꼴, 크기, 확대율, 보기 방식은 출력 파일에 저장되지 않습니다.');
  for (const entry of project.preservation) {
    if (entry.status !== 'mapped') omitted(entry.feature, entry.location, entry.detail);
  }
  for (const diagnostic of projection.diagnostics) approximate('projection.mapping', diagnostic.path,
    `이 부분은 그대로 변환되지 않습니다: ${diagnostic.message}`);
  for (const tuplet of projection.nestedTuplets) {
    switch (target) {
      case 'gp': add('rhythm.tuplet.structure', tuplet.id, { impact: 'blocked',
        detail: '.gp 파일은 중첩되거나 마디를 넘는 잇단음표를 담을 수 없어 출력을 중단합니다. 리듬을 단순화한 사본이나 alphaTex를 사용하세요.' }); break;
      case 'alphatex': approximate('rhythm.tuplet.structure', tuplet.id,
        '음 길이는 그대로 유지되지만 중첩·마디 간 잇단음표 괄호는 표시되지 않습니다.'); break;
      default: assertNever(target);
    }
  }
  for (const measure of score.measures) {
    if (measure.tempoEvents.some(event => !Number.isInteger(event.bpm))) approximate('tempo.precision', measure.id,
      '소수점 BPM은 정수로 반올림될 수 있습니다.');
    if (measure.jumps.some(jump => jump.kind === 'ds' || jump.kind === 'toCoda')) approximate('navigation.target', measure.id,
      '진행 기호는 저장되지만 어느 마디로 가는지는 받는 프로그램이 기호를 보고 다시 결정합니다.');
    if (compareQ(measure.actualSpanQ, rationalQ(BigInt(measure.meter.beats * 4), BigInt(measure.meter.unit))) !== 0) {
      approximate('measure.actualSpan', measure.id, '마디 길이는 출력된 음표와 쉼표로부터 다시 계산됩니다.');
    }
  }
  if (score.backing || score.assets.length) omitted('audio.backing', '악보 전체', '반주 오디오, 동기점, 첨부 파일은 이 형식에 포함되지 않습니다. 혼합 WAV나 .fretline을 사용하세요.');
  if (score.masterEqualizer?.length) omitted('audio.masterEqualizer', '마스터', '마스터 EQ 설정은 포함되지 않습니다.');
  for (const scale of score.scales ?? []) approximate('scale.structure', scale.eventId, '스케일은 설명 텍스트로만 저장되며 받는 프로그램에서 편집할 수 없습니다.');
  for (const automation of score.automations) {
    switch (automation.kind) {
      case 'program': break;
      case 'sustain':
        if (target === 'alphatex') omitted('automation.sustain', automation.id, '서스테인 페달 변경은 alphaTex에 저장되지 않습니다.');
        break;
      case 'volume': case 'pan':
        if (target === 'gp') omitted(`automation.${automation.kind}`, automation.id, '트랙의 처음 볼륨·팬 값만 저장되고 중간의 변경은 생략됩니다.');
        break;
      case 'expression': case 'pitchBend': omitted(`automation.${automation.kind}`, automation.id, '이 컨트롤러 변경은 저장되지 않습니다.'); break;
      default: assertNever(automation.kind);
    }
  }
  for (const track of score.tracks) {
    if (track.mixer?.equalizer.length) omitted('audio.trackEqualizer', track.id, '트랙 EQ 설정은 포함되지 않습니다.');
    if (track.mixer) approximate('mixer.precision', track.id, '트랙 볼륨과 팬은 정수 단위로 반올림됩니다.');
    for (const staff of track.staves) for (const voice of staff.voices) for (const bar of voice.bars) {
      switch (bar.kind) {
        case 'inactive': break;
        case 'active':
          for (const event of bar.events) {
            if (event.duration !== 'fullMeasure' && event.duration.base > 256) {
              switch (target) {
                case 'gp': add('rhythm.glyph', event.id, { impact: 'blocked',
                  detail: '.gp 파일은 256분음표보다 짧은 음을 담을 수 없어 출력을 중단합니다. 리듬을 단순화한 사본이나 alphaTex를 사용하세요.' }); break;
                case 'alphatex': approximate('rhythm.glyph', event.id, '음 길이는 그대로 유지되지만 음표 모양은 작성한 것과 달라집니다.'); break;
                default: assertNever(target);
              }
            }
            if (target === 'gp' && event.tremoloBar?.length) {
              if (event.tremoloBar.length > 4) omitted('technique.tremoloBar', event.id, '점이 4개를 넘는 트레몰로 바 곡선은 저장되지 않습니다.');
              else approximate('technique.tremoloBar', event.id, '트레몰로 바 곡선은 시작·중간·끝 세 점으로 단순화됩니다.');
            }
            switch (event.kind) {
              case 'spacer': approximate('rhythm.spacer', event.id, '보이지 않는 간격은 받는 프로그램에서 쉼표로 표시될 수 있습니다.'); continue;
              case 'rest': continue;
              case 'noteGroup': break;
              default: assertNever(event);
            }
            for (const note of event.notes) {
              if (note.audio) omitted('note.audio', note.id, '음표별 속도, 공격 오프셋, 소리 길이는 저장되지 않습니다.');
              for (const technique of note.techniques) {
                switch (technique.kind) {
                  case 'bend':
                    if (target === 'gp') {
                      if (technique.points.length > 4) omitted('technique.bend', note.id, '점이 4개를 넘는 벤드 곡선은 저장되지 않습니다.');
                      else approximate('technique.bend', note.id, '벤드 곡선은 시작·중간·끝 세 점으로 단순화됩니다.');
                    }
                    break;
                  case 'trill':
                    if (target === 'gp') omitted('technique.trill.speed', note.id, '트릴 음은 저장되지만 트릴 속도는 저장되지 않습니다.');
                    break;
                  case 'slide':
                    if (technique.target) approximate('technique.slide.target', note.id, '슬라이드 종류는 저장되지만 도착 음은 받는 프로그램이 다시 연결합니다.');
                    break;
                  case 'harmonic': case 'legato': case 'tremoloPicking': case 'fingering': case 'vibrato': case 'pickStroke':
                  case 'palmMute': case 'letRing': case 'staccato': case 'accent': case 'heavyAccent': case 'dead': case 'ghost':
                  case 'tap': case 'slap': case 'pop': break;
                  default: assertNever(technique);
                }
              }
            }
          }
          break;
        default: assertNever(bar);
      }
    }
  }
  if (target === 'alphatex' && score.layout.systemBreaks.length) omitted('layout.systemBreaks', '악보 전체', '수동으로 지정한 줄 바꿈은 alphaTex에 저장되지 않습니다.');
  return { engineVersion: '1.9.0', target, diagnostics };
}
