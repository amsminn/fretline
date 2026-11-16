import { model } from '@coderline/alphatab';
import type { PreservationEntry, ProjectV1 } from '../../domain/project';
import type { Technique } from '../../domain/notation';
import type { MeasureId, NoteId } from '../../domain/ids';
import type { Jump } from '../../domain/document';
import { rationalQ } from '../../domain/rational';
import { assertNever } from '../../domain/diagnostics';

export type CompatibilityDiagnostic = {
  readonly feature: string;
  readonly location: string;
  readonly status: 'mapped' | 'unsupported' | 'inventory-unknown';
  readonly impact: string;
  readonly alternative: string;
};
export type CompatibilityReport = {
  readonly inventoryVersion: 1;
  readonly engineVersion: '1.9.0';
  readonly format: string;
  readonly sourceHash: string;
  readonly diagnostics: readonly CompatibilityDiagnostic[];
};
const kindLabels: Readonly<Record<string, string>> = {
  Score: '악보', MasterBar: '마디', Track: '트랙', Staff: '보표', Bar: '마디', Voice: '성부', Beat: '박', Note: '음표',
};
const featureLabels: Readonly<Record<string, string>> = {
  'container.private-fields': '원본의 비공개 정보', 'structure.voice-overflow': '마디 길이를 넘는 음표', 'import.format': '파일 형식',
  'MIDI.quantization': 'MIDI 양자화', 'MIDI.notation': 'MIDI 기보 정보', 'MIDI.pitchBend': 'MIDI 피치 벤드', 'MIDI.volumeBoost': 'MIDI 볼륨 상한',
  'tempo.linear': '연속 템포 전환', 'layout/audio': '스타일·음색·반주', 'techniques/audio': '주법·오디오 설정', 'chords/diagrams/automation': '코드 다이어그램·자동화',
  jumps: '진행 지시기호', slur: '슬러', tuplet: '잇단음표', 'time-modification': '잇단음표 비율',
  'repeat.unclosed': '닫히지 않은 반복', 'repeat.unreadable': '반복 구조', 'layout.appearance': '표시 설정', 'note.unreadable': '읽지 못한 음표', 'tie.released': '풀어 읽은 붙임줄', 'tuplet.incomplete': '덜 채워진 잇단음표',
  'tempo.range': '템포 범위', 'Staff.capo': '카포', 'automation.program': '악기 변경', 'chord.spelling': '코드 구성음', 'chord.name': '코드 이름',
  'Note.dynamics': '음표별 셈여림', 'Beat.vibrato': '박 전체 비브라토', 'MasterBar.tripletFeel': '셔플 리듬', 'Beat.brushDuration': '스트럼 속도',
  'Beat.fermata': '늘임표', 'MasterBar.fermata': '늘임표', 'Beat.crescendo': '크레셰도', 'Beat.barreFret': '바레 표시', 'Beat.barreShape': '바레 표시',
  'Bar.keySignature': '트랙별 조표', 'Bar.clef': '마디별 음자리표',
  metadata: '곡 정보', measures: '마디', tracks: '트랙', ties: '붙임줄', tuplets: '잇단음표', chords: '코드', lyrics: '가사', automations: '자동화',
};
const statusLabels: Readonly<Record<CompatibilityDiagnostic['status'], string>> = { mapped: '지원', unsupported: '미지원', 'inventory-unknown': '검증 안 됨' };

/** User-facing Korean heading for a machine feature key; engine fields read as `<kind> 정보: <field>`. */
export function describeFeature(feature: string): string {
  const known = featureLabels[feature];
  if (known) return known;
  const dot = feature.indexOf('.');
  const kind = dot > 0 ? kindLabels[feature.slice(0, dot)] : undefined;
  return kind ? `${kind} 정보: ${feature.slice(dot + 1)}` : `원본 정보: ${feature}`;
}
export const describeStatus = (status: CompatibilityDiagnostic['status']): string => statusLabels[status];
/** Machine locations (`Score`, `MasterBar 0 (0-based)`, overflow JSON) become 1-based user terms; file names and user text pass through. */
export function describeLocation(location: string): string {
  if (location === 'Score') return '악보 전체';
  const indexed = /^(Score|MasterBar|Track|Staff|Bar|Voice|Beat|Note) (\d+) \(0-based\)$/.exec(location);
  if (indexed) return `${Number(indexed[2]) + 1}번째 ${kindLabels[indexed[1] ?? ''] ?? indexed[1]}`;
  if (location.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(location);
      if (typeof parsed === 'object' && parsed !== null && 'voice' in parsed && typeof parsed.voice === 'number') return `마디 구조 · 성부 ${parsed.voice}`;
    } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }
  return location;
}

export const fieldMap = {
  Score: 'title subTitle artist album words music copyright instructions notices masterBars tracks',
  MasterBar: 'timeSignatureNumerator timeSignatureDenominator isRepeatStart repeatCount alternateEndings tempoAutomations section isFreeTime isAnacrusis directions',
  Track: 'name staves playbackInfo isVisibleOnMultiTrack lineBreaks',
  Staff: 'bars stringTuning capo isPercussion showTablature showStandardNotation transpositionPitch chords',
  Bar: 'voices keySignature keySignatureType clef',
  Voice: 'beats',
  Beat: 'notes duration dots isEmpty tupletNumerator tupletDenominator text lyrics chordId graceType dynamics fade brushType whammyBarPoints rasgueado pickStroke tap slap pop tremoloPicking automations',
  Note: 'fret string octave tone percussionArticulation isTieDestination isPalmMute isLetRing isStaccato isDead isGhost isLeftHandTapped bendPoints harmonicType harmonicValue slideInType slideOutType hammerPullDestination vibrato accentuated leftHandFinger rightHandFinger trillValue trillSpeed',
} as const;
// References, caches, and derived values do not represent authored fields.
const derived = new Set(('id index score track staff bar voice beat previousBeat nextBeat previousBar nextBar previousMasterBar nextMasterBar ' +
  'repeatGroup start displayStart playbackStart displayDuration playbackDuration minNote maxNote minStringNote maxStringNote ' +
  'noteStringLookup noteValueLookup tupletGroup graceGroup graceIndex tieOrigin tieDestination hammerPullOrigin ' +
  'slideOrigin slideTarget letRingDestination palmMuteDestination bendOrigin maxBendPoint maxWhammyPoint minWhammyPoint ' +
  'slurOrigin slurDestination effectSlurOrigin effectSlurDestination ' +
  // The engine computes these from fields that are mapped (bend points, legato targets, note flags).
  'shortestDuration bendType isContinuedBend whammyBarType isHammerPullOrigin isEffectSlurOrigin isEffectSlurDestination ' +
  'hasEffectSlur effectSlur effectSlurSegment isPalmMute isLetRing actualBeamingRules').split(' '));
// Engraving and display preferences. They do not change the music, so they are reported as one finding.
const appearance = new Set(('Score.stylesheet Score.style Score.tab Score.systemsLayout Score.defaultSystemsLayout ' +
  'Track.color Track.shortName Track.systemsLayout Track.defaultSystemsLayout Track.percussionArticulations ' +
  'Staff.displayTranspositionPitch Staff.showSlash Staff.showNumbered Staff.standardNotationLineCount ' +
  'MasterBar.displayScale MasterBar.displayWidth MasterBar.beamingRules MasterBar.isDoubleBar ' +
  'Bar.displayScale Bar.displayWidth Bar.barLineLeft Bar.barLineRight ' +
  'Beat.preferredBeamDirection Beat.beamingMode Note.accidentalMode').split(' '));

export class CompatibilityInventory {
  /** Findings that need their own location, such as a bar that must be repaired before editing. */
  readonly diagnostics: CompatibilityDiagnostic[] = [];
  private readonly findings = new Map<string, { readonly feature: string; readonly location: string; readonly impact: string; count: number }>();
  /** A real score repeats one finding thousands of times; it is reported once with how often it occurs. */
  add(feature: string, location: string, impact: string): void {
    const key = `${feature}\n${impact}`;
    const finding = this.findings.get(key);
    if (finding) finding.count++;
    else this.findings.set(key, { feature, location, impact, count: 1 });
  }
  report(): readonly CompatibilityDiagnostic[] {
    return [...this.diagnostics, ...[...this.findings.values()].map(finding => ({
      feature: finding.feature, location: finding.count > 1 ? `${finding.count}곳` : finding.location, status: 'unsupported' as const,
      impact: finding.impact, alternative: '원본을 보존하고 편집 가능한 사본에서 이 항목을 별도로 작성하세요.' }))];
  }
  inspect(kind: keyof typeof fieldMap, value: object, defaults: object): void {
    const mapped = new Set(fieldMap[kind].split(' '));
    const initial = new Map(Object.entries(defaults));
    const location = `${kind}${'index' in value ? ` ${String(value.index) + ' (0-based)'}` : ''}`;
    for (const [key, item] of Object.entries(value)) {
      if (mapped.has(key) || derived.has(key) || key.startsWith('_') || item === null || item === undefined) continue;
      const baseline = initial.get(key);
      if (item === baseline || (typeof item === 'number' && Number.isNaN(item) && typeof baseline === 'number' && Number.isNaN(baseline))) continue;
      if (Array.isArray(item) && item.length === 0) continue;
      if ((item instanceof Map || item instanceof Set) && item.size === 0) continue;
      // A note's own dynamic is lost only where it differs from its beat's, which is mapped.
      if (value instanceof model.Note && key === 'dynamics' && item === value.beat.dynamics) continue;
      if (appearance.has(`${kind}.${key}`)) this.add('layout.appearance', location, '색, 약칭, 기둥 방향, 줄 배치 같은 표시 설정은 읽지 않습니다. 원본에는 남아 있습니다.');
      else this.add(`${kind}.${key}`, location, '이 필드는 편집 문서로 매핑되지 않습니다. 정확한 원본 바이트에만 남습니다.');
    }
  }
}

export function mapDirections(master: model.MasterBar, ids: readonly MeasureId[], inventory: CompatibilityInventory): readonly Jump[] {
  const result: Jump[] = [];
  // Match the pinned reader's nearest backward Segno / forward Coda lookup.
  const target = (direction: model.Direction, backwards: boolean): MeasureId | undefined => {
    const bars = master.score.masterBars;
    const before = bars.slice(0, master.index + 1).reverse();
    const after = bars.slice(master.index);
    const found = [...(backwards ? before : after), ...(backwards ? after : before)]
      .find(m => m.directions?.has(direction));
    return found ? ids[found.index] : undefined;
  };
  const controls = [...(master.directions ?? [])].filter(d => d >= model.Direction.JumpDaCapo);
  for (const direction of master.directions ?? []) {
    const unsupported = (reason: string): void => inventory.add(`MasterBar.directions.${model.Direction[direction]}`,
      `MasterBar ${master.index} (0-based)`, reason);
    if (controls.length > 1 && controls.includes(direction)) {
      unsupported('한 마디의 여러 진행 명령은 표현할 수 없습니다. 원본에 보존됩니다.');
      continue;
    }
    let kind: 'dc' | 'ds';
    let until: 'end' | 'fine' | 'coda';
    switch (direction) {
      case model.Direction.TargetSegno: result.push({ kind: 'segno' }); continue;
      case model.Direction.TargetCoda: result.push({ kind: 'coda' }); continue;
      case model.Direction.TargetFine: result.push({ kind: 'fine' }); continue;
      case model.Direction.JumpDaCoda: {
        const destination = target(model.Direction.TargetCoda, false);
        if (destination) result.push({ kind: 'toCoda', target: destination });
        else unsupported('Coda 대상이 없어 진행 명령을 연결할 수 없습니다. 원본에 보존됩니다.');
        continue;
      }
      case model.Direction.JumpDaCapo: kind = 'dc'; until = 'end'; break;
      case model.Direction.JumpDaCapoAlFine: kind = 'dc'; until = 'fine'; break;
      case model.Direction.JumpDaCapoAlCoda: kind = 'dc'; until = 'coda'; break;
      case model.Direction.JumpDalSegno: kind = 'ds'; until = 'end'; break;
      case model.Direction.JumpDalSegnoAlFine: kind = 'ds'; until = 'fine'; break;
      case model.Direction.JumpDalSegnoAlCoda: kind = 'ds'; until = 'coda'; break;
      case model.Direction.TargetSegnoSegno:
      case model.Direction.TargetDoubleCoda:
      case model.Direction.JumpDaCapoAlDoubleCoda:
      case model.Direction.JumpDalSegnoAlDoubleCoda:
      case model.Direction.JumpDalSegnoSegno:
      case model.Direction.JumpDalSegnoSegnoAlCoda:
      case model.Direction.JumpDalSegnoSegnoAlDoubleCoda:
      case model.Direction.JumpDalSegnoSegnoAlFine:
      case model.Direction.JumpDaDoubleCoda:
        unsupported('겹 Segno/Coda 진행 기호는 편집 문서에서 표현할 수 없습니다. 원본에 보존됩니다.');
        continue;
      default: assertNever(direction);
    }
    if ((until === 'fine' && !target(model.Direction.TargetFine, false)) ||
      (until === 'coda' && !target(model.Direction.TargetCoda, false))) {
      unsupported('Fine/Coda 대상이 없어 진행 명령을 연결할 수 없습니다. 원본에 보존됩니다.');
      continue;
    }
    switch (kind) {
      case 'dc': result.push({ kind, until }); break;
      case 'ds': {
        const destination = target(model.Direction.TargetSegno, true);
        if (destination) result.push({ kind, target: destination, until });
        else unsupported('Segno 대상이 없어 진행 명령을 연결할 수 없습니다. 원본에 보존됩니다.');
        break;
      }
      default: assertNever(kind);
    }
  }
  return result;
}

export function preservationReport(project: ProjectV1): CompatibilityReport | null {
  if (!project.source) return null;
  return { inventoryVersion: 1, engineVersion: '1.9.0', format: project.preservation.find(e => e.feature === 'import.format')?.location ?? project.source.extension, sourceHash: project.source.sha256,
    diagnostics: project.preservation.filter(entry => entry.feature !== 'import.format').map(entry => ({
      feature: entry.feature, location: entry.location,
      status: entry.status === 'mapped' ? 'mapped' : entry.feature === 'container.private-fields' ? 'inventory-unknown' : 'unsupported',
      impact: entry.detail, alternative: entry.status === 'mapped' ? '편집 및 자체 프로젝트 저장 지원' : '원본을 보존하고 편집 가능한 사본으로 변환하세요.',
    })) };
}
export function preservationEntries(report: CompatibilityReport): readonly PreservationEntry[] {
  return [{ feature: 'import.format', location: report.format, status: 'mapped', detail: `inventory=${report.inventoryVersion}; alphaTab=${report.engineVersion}`, dependencies: [] },
    ...report.diagnostics.map(d => ({ feature: d.feature, location: d.location,
      status: d.status === 'mapped' ? 'mapped' as const : 'unverified' as const, detail: `${d.impact} ${d.alternative}`, dependencies: [d.location] }))];
}

export function mapTechniques(note: model.Note, ids: ReadonlyMap<model.Note, NoteId>): readonly Technique[] {
  const result: Technique[] = [];
  for (const [present, kind] of [
    [note.isPalmMute, 'palmMute'], [note.isLetRing, 'letRing'], [note.isStaccato, 'staccato'],
    [note.isDead, 'dead'], [note.isGhost, 'ghost'], [note.isLeftHandTapped || note.beat.tap, 'tap'],
    [note.beat.slap, 'slap'], [note.beat.pop, 'pop'],
  ] as const) if (present) result.push({ kind });
  switch (note.accentuated) {
    case model.AccentuationType.None: break;
    case model.AccentuationType.Normal: result.push({ kind: 'accent' }); break;
    case model.AccentuationType.Heavy: result.push({ kind: 'heavyAccent' }); break;
    case model.AccentuationType.Tenuto: break;
    default: assertNever(note.accentuated);
  }
  if (note.bendPoints?.length) result.push({ kind: 'bend', points: note.bendPoints.map(p => ({
    position: rationalQ(BigInt(p.offset), 60n), semitones: rationalQ(BigInt(p.value), 2n),
  })) });
  const harmonics = new Map<model.HarmonicType, Extract<Technique, { kind: 'harmonic' }>['style']>([
    [model.HarmonicType.Natural, 'natural'], [model.HarmonicType.Artificial, 'artificial'],
    [model.HarmonicType.Pinch, 'pinch'], [model.HarmonicType.Tap, 'tap'],
    [model.HarmonicType.Semi, 'semi'], [model.HarmonicType.Feedback, 'feedback'],
  ] as const);
  const harmonic = harmonics.get(note.harmonicType);
  if (harmonic) result.push({ kind: 'harmonic', style: harmonic, fret: decimalQ(note.harmonicValue) });
  const slideIn = new Map<model.SlideInType, 'inAbove' | 'inBelow'>([[model.SlideInType.IntoFromAbove, 'inAbove'], [model.SlideInType.IntoFromBelow, 'inBelow']]).get(note.slideInType);
  if (slideIn) result.push({ kind: 'slide', style: slideIn });
  const slideOut = new Map<model.SlideOutType, 'shift' | 'legato' | 'outUp' | 'outDown'>([
    [model.SlideOutType.Shift, 'shift'], [model.SlideOutType.Legato, 'legato'],
    [model.SlideOutType.OutUp, 'outUp'], [model.SlideOutType.OutDown, 'outDown'],
  ] as const).get(note.slideOutType);
  if (slideOut) result.push({ kind: 'slide', style: slideOut });
  const target = note.hammerPullDestination ? ids.get(note.hammerPullDestination) : undefined;
  if (target) result.push({ kind: 'legato', target });
  if (note.vibrato !== model.VibratoType.None) result.push({ kind: 'vibrato', strength: note.vibrato === model.VibratoType.Wide ? 'wide' : 'slight' });
  if (note.isFingering) result.push({ kind: 'fingering', left: String(note.leftHandFinger), right: String(note.rightHandFinger) });
  if (note.isTrill) result.push({ kind: 'trill', fret: note.trillFret, base: note.trillSpeed });
  if (note.beat.tremoloSpeed) result.push({ kind: 'tremoloPicking', base: note.beat.tremoloSpeed });
  if (note.beat.pickStroke !== model.PickStroke.None) result.push({ kind: 'pickStroke', direction: note.beat.pickStroke === model.PickStroke.Up ? 'up' : 'down' });
  return result;
}
export function decimalQ(value: number) {
  if (!Number.isFinite(value)) throw new TypeError('Non-finite imported value');
  const text = String(value);
  if (text.includes('e')) throw new TypeError('Imported decimal precision exceeds supported rational range');
  const digits = text.split('.')[1]?.length ?? 0;
  return rationalQ(BigInt(text.replace('.', '')), 10n ** BigInt(digits));
}
