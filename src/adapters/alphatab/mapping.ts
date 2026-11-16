import { panFromController } from '../pan';
import { model } from '@coderline/alphatab';
import type { Measure, ScoreDocument, Track, VoiceLane, ScoreEvent, Note } from '../../domain/document';
import type { NoteId, EventId, TupletId } from '../../domain/ids';
import { newId } from '../../domain/ids';
import { addQ, compareQ, durationQ, multiplyQ, rationalQ, subtractQ, zeroQ } from '../../domain/rational';
import { parseScoreDocument, validateDocument } from '../../domain/validate';
import { assertNever, DomainError } from '../../domain/diagnostics';
import { compileOccurrences } from '../../domain/timeline';
import { decimalQ, mapDirections, mapTechniques } from './compatibility';
import type { CompatibilityInventory } from './compatibility';
import { eventDurationQ } from '../../domain/event-time';
import { silence } from '../../domain/commands/duration';

const noteValues = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024] as const;

export function mapScore(score: model.Score, inventory: CompatibilityInventory): ScoreDocument {
  const notes = new Map<model.Note, NoteId>();
  const events = new Map<model.Beat, EventId>();
  const tuplets: ScoreDocument['tuplets'][number][] = [];
  const ties: ScoreDocument['ties'][number][] = [];
  const chords: ScoreDocument['chords'][number][] = [];
  const diagrams: ScoreDocument['diagrams'][number][] = [];
  const lyrics: ScoreDocument['lyrics'][number][] = [];
  const automations: ScoreDocument['automations'][number][] = [];
  inventory.inspect('Score', score, new model.Score());
  // Files in the wild hold notes the document cannot: drum ties without a hit, pitches written as
  // frets below the nut, two notes on one string. A track with frets below the nut is read by pitch;
  // what still cannot be read is dropped and reported, never a reason to refuse the file.
  const trackKinds = new Map<model.Track, Track['instrument']['kind']>(score.tracks.map(track => [track,
    track.isPercussion ? 'percussion'
      : !track.staves.some(s => s.isStringed) || track.staves.some(s => s.bars.some(b => b.voices.some(v =>
        v.beats.some(beat => beat.notes.some(n => n.isStringed && n.fret < 0))))) ? 'pitched' : 'fretted']));
  const isMidi = (value: number): boolean => Number.isInteger(value) && value >= 0 && value <= 127;
  const readNote = (note: model.Note): Pick<Extract<Note, { kind: 'percussion' }>, 'kind' | 'midi' | 'articulation'> |
    Pick<Extract<Note, { kind: 'fretted' }>, 'kind' | 'string' | 'fret'> | Pick<Extract<Note, { kind: 'pitched' }>, 'kind' | 'midi'> | null => {
    const staff = note.beat.voice.bar.staff;
    const kind = trackKinds.get(staff.track);
    switch (kind) {
      case 'percussion':
        return note.isPercussion && isMidi(note.realValue)
          ? { kind, midi: note.realValue, articulation: String(note.percussionArticulation) } : null;
      case 'fretted': {
        // alphaTab numbers strings from the bottom; the domain numbers from the top.
        const string = staff.tuning.length - note.string + 1;
        return note.isStringed && Number.isInteger(note.fret) && note.fret >= 0 && note.fret <= 99 && string >= 1 && string <= staff.tuning.length
          ? { kind, string, fret: note.fret } : null;
      }
      case 'pitched': {
        const midi = note.isStringed ? note.calculateRealValue(false, false) : note.octave * 12 + note.tone;
        return isMidi(midi) ? { kind, midi } : null;
      }
      case undefined: return null;
      default: return assertNever(kind);
    }
  };
  const skipped = new Set<model.Beat>();
  for (const t of score.tracks) for (const s of t.staves) for (const b of s.bars) for (const v of b.voices) for (const beat of v.beats) {
    const strings = new Set<number>();
    const readable = beat.notes.filter(note => {
      const value = readNote(note);
      if (!value || (value.kind === 'fretted' && strings.has(value.string))) return false;
      if (value.kind === 'fretted') strings.add(value.string);
      return true;
    });
    for (let dropped = readable.length; dropped < beat.notes.length; dropped++) {
      inventory.add('note.unreadable', `${t.index}/${b.index}`, '음높이나 줄·프렛을 확정할 수 없는 음표는 편집 문서에서 뺐습니다. 원본에는 남아 있습니다.');
    }
    // A grace beat has no length, so one left without notes cannot become a rest.
    if (beat.isEmpty || (beat.graceType !== model.GraceType.None && readable.length === 0)) { skipped.add(beat); continue; }
    events.set(beat, newId('event'));
    for (const note of readable) notes.set(note, newId('note'));
  }
  const measureIds = score.masterBars.map(() => newId('measure'));
  const imported: Measure[] = score.masterBars.map(m => {
    inventory.inspect('MasterBar', m, new model.MasterBar());
    const bar = score.tracks[0]?.staves[0]?.bars[m.index];
    const nominal = rationalQ(BigInt(m.timeSignatureNumerator) * 4n, BigInt(m.timeSignatureDenominator));
    // Importer duration is tick-rounded for tuplets; only pickup/free-time uses it.
    const span = m.isAnacrusis || m.isFreeTime ? rationalQ(BigInt(m.calculateDuration()), 960n) : nominal;
    const id = measureIds[m.index];
    if (!id) throw new TypeError('Imported master bar is outside score');
    return { id, meter: { beats: m.timeSignatureNumerator, unit: m.timeSignatureDenominator },
      actualSpanQ: span, key: { fifths: bar?.keySignature ?? 0, mode: bar?.keySignatureType === model.KeySignatureType.Minor ? 'minor' : 'major' },
      tempoEvents: m.tempoAutomations.length ? m.tempoAutomations.map(a => ({
        offsetQ: multiplyQ(span, decimalQ(Number.isFinite(a.ratioPosition) ? Math.max(0, Math.round(a.ratioPosition * 1e6) / 1e6) : 0)),
        bpm: a.value, transition: a.isLinear ? 'linear' : 'step' })) : m.index === 0 ? [{ offsetQ: zeroQ, bpm: score.tempo, transition: 'step' }] : [],
      repeats: { start: m.isRepeatStart, ...(m.isRepeatEnd ? { totalPlays: m.repeatCount } : {}) },
      endings: Array.from({ length: 8 }, (_, i) => i + 1).filter(pass => (m.alternateEndings & (1 << (pass - 1))) !== 0),
      jumps: mapDirections(m, measureIds, inventory), ...(m.section ? { section: { name: m.section.text, letter: m.section.marker } } : {}),
      ...(m.isFreeTime ? { freeTime: true } : {}) };
  });
  // A tempo change written at the very end of a bar belongs to the next bar; tempos outside the
  // supported range are brought to its edge.
  const carried: Measure['tempoEvents'][number][] = [];
  const timed: Measure[] = imported.map(measure => {
    const kept: Measure['tempoEvents'][number][] = [];
    for (const event of [...carried.splice(0), ...measure.tempoEvents]) {
      if (!Number.isFinite(event.bpm)) continue;
      const bpm = Math.min(400, Math.max(10, event.bpm));
      if (bpm !== event.bpm) inventory.add('tempo.range', measure.id, '10~400 BPM을 벗어난 템포는 가장 가까운 값으로 읽었습니다.');
      if (compareQ(event.offsetQ, measure.actualSpanQ) >= 0) carried.push({ ...event, bpm, offsetQ: zeroQ });
      else kept.push({ ...event, bpm });
    }
    return { ...measure, tempoEvents: kept.map((event, order) => ({ event, order }))
      .sort((a, b) => compareQ(a.event.offsetQ, b.event.offsetQ) || a.order - b.order).map(entry => entry.event) };
  });
  // An end repeat with no start goes back to the bar after the previous repeat; a start that is never closed repeats nothing.
  const open: number[] = [];
  const closed = new Set<number>();
  let afterRepeat = 0;
  for (const [i, measure] of timed.entries()) {
    if (measure.repeats.start) open.push(i);
    if (measure.repeats.totalPlays === undefined) continue;
    closed.add(open.pop() ?? afterRepeat);
    afterRepeat = i + 1;
  }
  for (const start of open) inventory.add('repeat.unclosed', `MasterBar ${start} (0-based)`, '닫는 기호가 없는 반복 시작은 반복 없이 읽었습니다.');
  const measures: Measure[] = timed.map((measure, i) => measure.repeats.start === closed.has(i) ? measure
    : { ...measure, repeats: { ...measure.repeats, start: closed.has(i) } });
  const requireEvent = (beat: model.Beat): EventId => {
    const value = events.get(beat);
    if (!value) throw new TypeError('Imported beat is outside score');
    return value;
  };
  const mapNote = (note: model.Note): Note => {
    inventory.inspect('Note', note, new model.Note());
    if (note.accentuated === model.AccentuationType.Tenuto) inventory.add('Note.tenuto', String(note.id), '테누토는 원본에만 보존됩니다.');
    const id = notes.get(note);
    if (!id) throw new TypeError('Imported note is outside score');
    const from = note.tieOrigin ? notes.get(note.tieOrigin) : undefined;
    if (note.isTieDestination && from) ties.push({ id: newId('tie'), from, to: id });
    const value = readNote(note);
    if (!value) throw new TypeError('Imported note is unreadable');
    return { id, techniques: mapTechniques(note, notes), ...value };
  };
  const tracks: Track[] = score.tracks.map(track => {
    inventory.inspect('Track', track, new model.Track());
    const trackId = newId('track');
    const staves = track.staves.map(staff => {
      inventory.inspect('Staff', staff, new model.Staff());
      const voices: VoiceLane[] = ([1, 2, 3, 4] as const).map(number => ({
        id: newId('voice'), number, bars: measures.map((measure, i) => {
          const bar = staff.bars[i];
          if (!bar) throw new TypeError('Imported staff has missing bars');
          if (number === 1) {
            inventory.inspect('Bar', bar, new model.Bar());
            if (bar.clef !== staff.bars[0]?.clef) inventory.add('Bar.clef', `${staff.index}/${i}`, '소절별 음자리표 변경은 원본에 보존됩니다. 편집 문서는 첫 음자리표를 사용합니다.');
            if (bar.keySignature !== measure.key.fifths || (bar.keySignatureType === model.KeySignatureType.Minor) !== (measure.key.mode === 'minor')) {
              inventory.add('Bar.keySignature', `${staff.index}/${i}`, '트랙별 조표 차이는 원본에 보존됩니다. 편집 문서는 전역 조표를 사용합니다.');
            }
          }
          const voice = bar.voices[number - 1];
          if (!voice || voice.isEmpty) return { kind: 'inactive', measureId: measure.id };
          inventory.inspect('Voice', voice, new model.Voice());
          const lane = voice.beats.filter(b => !skipped.has(b));
          const tupletOf = new Map<model.Beat, TupletId>();
          const completion = new Map<model.Beat, ScoreEvent[]>();
          for (let start = 0; start < lane.length; start++) {
            const first = lane[start];
            if (!first || first.graceType !== model.GraceType.None || !first.hasTuplet) continue;
            // One engine group is one tuplet. Grace notes between its members belong to it without length.
            let end = start;
            for (let i = start + 1; i < lane.length; i++) {
              const beat = lane[i];
              if (!beat) break;
              if (beat.graceType !== model.GraceType.None) continue;
              if (!beat.hasTuplet || beat.tupletGroup !== first.tupletGroup ||
                beat.tupletNumerator !== first.tupletNumerator || beat.tupletDenominator !== first.tupletDenominator) break;
              end = i;
            }
            const members = lane.slice(start, end + 1);
            const written = members.filter(b => b.graceType === model.GraceType.None)
              .reduce((sum, b) => addQ(sum, durationQ({ base: b.duration, dots: b.dots })), zeroQ);
            const whole = (base: number) => multiplyQ(durationQ({ base, dots: 0 }), rationalQ(BigInt(first.tupletNumerator)));
            // Members of mixed length share the unit that makes the group exactly full.
            let unit = noteValues.find(base => compareQ(whole(base), written) === 0);
            const tid = newId('tuplet');
            const rests: ScoreEvent[] = [];
            if (!unit) {
              // An unfinished tuplet is completed with rests so that its members keep their written length.
              unit = [...noteValues].reverse().find(base => base <= first.duration && compareQ(whole(base), written) > 0) ?? 1;
              let missing = subtractQ(whole(unit), written);
              for (const base of noteValues) {
                const span = durationQ({ base, dots: 0 });
                while (compareQ(missing, span) >= 0) {
                  rests.push({ id: newId('event'), kind: 'rest', duration: { base, dots: 0, tupletIds: [tid] } });
                  missing = subtractQ(missing, span);
                }
              }
              if (compareQ(missing, zeroQ) !== 0) { start = end; continue; }
              inventory.add('tuplet.incomplete', `${staff.index}/${i}`, '덜 채워진 잇단음표는 쉼표로 채워 읽었습니다.');
            }
            tuplets.push({ id: tid, actual: first.tupletNumerator, normal: first.tupletDenominator, unit,
              eventIds: [...members.map(requireEvent), ...rests.map(rest => rest.id)] });
            for (const beat of members) tupletOf.set(beat, tid);
            const last = lane[end];
            if (last && rests.length) completion.set(last, rests);
            start = end;
          }
          const mapped: ScoreEvent[] = lane.flatMap((beat): ScoreEvent[] => {
            inventory.inspect('Beat', beat, new model.Beat());
            const id = requireEvent(beat);
            const tid = tupletOf.get(beat);
            const tupletIds = tid ? [tid] : [];
            const after = completion.get(beat) ?? [];
            const duration = { base: beat.duration, dots: beat.dots, tupletIds };
            const dynamics = new Map<number, NonNullable<ScoreEvent['dynamics']>>([
              [model.DynamicValue.PPP, 'ppp'], [model.DynamicValue.PP, 'pp'], [model.DynamicValue.P, 'p'],
              [model.DynamicValue.MP, 'mp'], [model.DynamicValue.MF, 'mf'], [model.DynamicValue.F, 'f'],
              [model.DynamicValue.FF, 'ff'], [model.DynamicValue.FFF, 'fff'],
            ]).get(beat.dynamics);
            if (!dynamics) inventory.add(`Beat.dynamics.${beat.dynamics}`, id, '이 셈여림은 편집 문서의 범위를 벗어납니다.');
            const fields = { id, ...(dynamics ? { dynamics } : {}),
              ...(beat.text ? { annotations: [beat.text] } : {}),
              ...(beat.whammyBarPoints?.length ? { tremoloBar: beat.whammyBarPoints.map(p => ({
                position: rationalQ(BigInt(p.offset), 60n), semitones: rationalQ(BigInt(p.value), 2n),
              })) } : {}),
              ...(beat.hasRasgueado ? { rasgueado: String(beat.rasgueado) } : {}),
            };
            if (beat.lyrics) beat.lyrics.forEach((text, verse) => lyrics.push({ id: newId('lyric'), eventId: id, verse: verse + 1, text, syllabic: 'single', extend: false }));
            const chord = beat.chord;
            if (chord) {
              // Many files name a chord without drawing it; only a drawn chord gets a diagram.
              const frets = chord.strings.slice(0, 16).map(f => Number.isInteger(f) && f >= 0 && f <= 99 ? f : null);
              const diagramId = frets.length ? newId('diagram') : undefined;
              if (diagramId) diagrams.push({ id: diagramId, name: chord.name, frets, fingers: frets.map(() => ''),
                barres: chord.barreFrets.filter(f => Number.isInteger(f) && f >= 1 && f <= 99).map(f => ({ fret: f, fromString: 1, toString: frets.length })) });
              const rootName = chord.name.match(/^[A-G][#b]?/)?.[0];
              const root = rootName ? new Map([['C', 0], ['C#', 1], ['Db', 1], ['D', 2], ['D#', 3], ['Eb', 3], ['E', 4], ['F', 5], ['F#', 6], ['Gb', 6], ['G', 7], ['G#', 8], ['Ab', 8], ['A', 9], ['A#', 10], ['Bb', 10], ['B', 11]]).get(rootName) : undefined;
              if (root !== undefined) chords.push({ id: newId('chord'), eventId: id, name: chord.name, root, intervals: [], ...(diagramId ? { diagramId } : {}) });
              else inventory.add('chord.name', id, `${chord.name}: 근음을 확정할 수 없어 코드 표기를 원본에만 보존합니다.`);
              inventory.add('chord.spelling', id, '코드 이름과 다이어그램은 보존되지만 엔진은 근음/구성음을 제공하지 않습니다.');
            }
            for (const a of beat.automations) {
              const kind = new Map<model.AutomationType, 'volume' | 'pan' | 'program'>([[model.AutomationType.Volume, 'volume'], [model.AutomationType.Balance, 'pan'], [model.AutomationType.Instrument, 'program']]).get(a.type);
              // alphaTab's MIDI generator multiplies these controllers by 8.
              // Quantize to the nearest MIDI byte (half up), saturating 16 to
              // 127; invert projectAutomations' 127-step volume/pan mapping.
              const controller = Math.max(0, Math.min(127, Math.round(a.value * 8)));
              if (kind === 'program' && !isMidi(a.value)) inventory.add('automation.program', id, '번호가 없는 악기 변경은 읽지 않았습니다.');
              else if (kind) automations.push({ id: newId('automation'), trackId, measureId: measure.id,
                offsetQ: rationalQ(BigInt(beat.displayStart), 960n), kind,
                value: kind === 'volume' ? controller / 127 : kind === 'pan' ? panFromController(controller) : a.value });
              else inventory.add(`automation.${a.type}`, id, '이 자동화 종류는 편집 문서에서 지원하지 않습니다.');
            }
            const readable = beat.notes.filter(note => notes.has(note));
            if (beat.isRest || readable.length === 0) return [{ ...fields, kind: 'rest', duration: beat.isFullBarRest ? 'fullMeasure' : duration }, ...after];
            const fade = new Map<model.FadeType, 'in' | 'out' | 'swell'>([[model.FadeType.FadeIn, 'in'], [model.FadeType.FadeOut, 'out'], [model.FadeType.VolumeSwell, 'swell']]).get(beat.fade);
            return [{ ...fields, kind: 'noteGroup', duration, notes: readable.map(mapNote),
              ...(beat.graceType !== model.GraceType.None ? { grace: { kind: beat.graceType === model.GraceType.OnBeat ? 'onBeat' : 'beforeBeat', slash: true } as const } : {}),
              ...(fade ? { fade } : {}),
              ...(beat.brushType === model.BrushType.BrushUp || beat.brushType === model.BrushType.BrushDown
                ? { brush: beat.brushType === model.BrushType.BrushUp ? 'up' : 'down' } as const : {}),
              ...(beat.brushType === model.BrushType.ArpeggioUp || beat.brushType === model.BrushType.ArpeggioDown
                ? { arpeggio: beat.brushType === model.BrushType.ArpeggioUp ? 'up' : 'down' } as const : {}) }, ...after];
          });
          let occupied = zeroQ;
          for (const event of mapped) {
            switch (event.kind) {
              case 'noteGroup': if (event.grace) continue; break;
              case 'rest': case 'spacer': break;
              default: assertNever(event);
            }
            occupied = addQ(occupied, event.duration === 'fullMeasure' ? measure.actualSpanQ : durationQ(event.duration,
              event.duration.tupletIds.flatMap(id => tuplets.filter(t => t.id === id))));
          }
          // GP permits implicit trailing silence. Materialize it exactly; never truncate overflow.
          let remaining = subtractQ(measure.actualSpanQ, occupied);
          if (compareQ(remaining, zeroQ) < 0) inventory.diagnostics.push({
            feature: 'structure.voice-overflow', location: JSON.stringify({ measureId: measure.id, voice: number, occupiedQ: occupied, nominalQ: measure.actualSpanQ }),
            status: 'unsupported', impact: `마디 ${i + 1}, 성부 ${number}: ${occupied.n}/${occupied.d}박이 ${measure.actualSpanQ.n}/${measure.actualSpanQ.d}박을 초과합니다. 원본 순서와 길이를 임시 불규칙 마디에 보존했습니다.`,
            alternative: '미리보기에서 같은 박자의 연속 마디로 분할하고 경계를 넘는 음을 붙임줄로 연결하세요. 확인 전에는 문서를 열지 않습니다.',
          });
          for (let base = 1; base <= 1024; base *= 2) {
            const span = durationQ({ base, dots: 0 });
            while (compareQ(remaining, span) >= 0) {
              mapped.push({ id: newId('event'), kind: 'rest', duration: { base, dots: 0, tupletIds: [] } });
              remaining = subtractQ(remaining, span);
            }
          }
          if (compareQ(remaining, zeroQ) > 0) throw new TypeError(`Unrepresentable trailing silence in measure ${i + 1}`);
          return { kind: 'active', measureId: measure.id, events: mapped };
        }),
      }));
      const clefs = new Map([[model.Clef.G2, 'treble'], [model.Clef.F4, 'bass'], [model.Clef.C3, 'alto'], [model.Clef.C4, 'tenor'], [model.Clef.Neutral, 'percussion']] as const);
      const fretted = trackKinds.get(track) === 'fretted';
      // A capo outside the fretboard is how some files shift a whole part; the shift moves into the tuning.
      const capo = fretted && Number.isInteger(staff.capo) ? Math.min(36, Math.max(0, staff.capo)) : 0;
      const shift = fretted && Number.isInteger(staff.capo) ? staff.capo - capo : 0;
      if (shift !== 0) inventory.add('Staff.capo', `${track.index}/${staff.index}`, '범위를 벗어난 카포 값은 튜닝에 더해 같은 음높이로 읽었습니다.');
      return { id: newId('staff'), tuning: fretted ? staff.tuning.map(pitch => Math.min(127, Math.max(0, pitch + shift))) : [], capo,
        clef: clefs.get(staff.bars[0]?.clef ?? model.Clef.G2) ?? 'treble',
        notationMode: staff.isPercussion ? 'drum' : fretted && staff.showTablature ? staff.showStandardNotation ? 'both' : 'tab' : 'standard', voices } as const;
    });
    for (const staff of track.staves) if (staff.transpositionPitch !== track.staves[0]?.transpositionPitch) {
      inventory.add('Staff.transpositionPitch', `${track.index}/${staff.index}`, '보표별 이조 차이는 원본에만 보존됩니다.');
    }
    return { id: trackId, name: track.name, transposition: track.staves[0]?.transpositionPitch ?? 0, instrument: { kind: trackKinds.get(track) ?? 'pitched',
      program: track.playbackInfo.program, bank: track.playbackInfo.bank }, staves,
      mixer: { volume: track.playbackInfo.volume / 16, pan: panFromController(Math.min(127, Math.round(track.playbackInfo.balance * 8))),
        mute: track.playbackInfo.isMute, solo: track.playbackInfo.isSolo, equalizer: [] } };
  });
  const systemBreaks = [...new Set(score.tracks.flatMap(t => [...(t.lineBreaks ?? [])]))].flatMap(index => measures[index] ? [measures[index].id] : []);
  const intermediate: ScoreDocument = { schemaVersion: 1, id: newId('score'),
    metadata: { title: score.title, subtitle: score.subTitle, artist: score.artist, album: score.album, words: score.words,
      music: score.music, copyright: score.copyright, instructions: score.instructions, notices: score.notices ? score.notices.split(/\r?\n/) : [] },
    measures, tracks, tuplets, ties, chords, diagrams, lyrics, automations, assets: [],
    layout: { systemBreaks, pageBreaks: [], hiddenTracks: tracks.filter((_, i) => !score.tracks[i]?.isVisibleOnMultiTrack).map(t => t.id), scale: 1,
      stylesheet: { fontFamily: 'Bravura', fontSize: 12, showTab: true, showStandard: true, showChordDiagrams: true } } };
  // A valid, explicitly reported intermediate can cross the worker/package boundary.
  // It is never accepted as an editable score until ImportReport confirms repair.
  const spans = measures.map((measure, i) => tracks.flatMap(t => t.staves.flatMap(s => s.voices.map(v => v.bars[i])))
    .reduce((max, bar) => {
      const occupied = bar?.kind === 'active' ? bar.events.reduce((q, e) => addQ(q, eventDurationQ(e, measure.actualSpanQ, intermediate)), zeroQ) : zeroQ;
      return compareQ(occupied, max) > 0 ? occupied : max;
    }, measure.actualSpanQ));
  const repaired: ScoreDocument = { ...intermediate,
    measures: measures.map((m, i) => {
      const span = spans[i];
      return span && compareQ(span, m.actualSpanQ) > 0 ? { ...m, actualSpanQ: span, freeTime: true } : m;
    }),
    tracks: tracks.map(t => ({ ...t, staves: t.staves.map(s => ({ ...s, voices: s.voices.map(v => ({
      ...v, bars: v.bars.map((bar, i) => {
        const measure = measures[i];
        const span = spans[i];
        if (!measure || !span || bar.kind === 'inactive' || (bar.events.length === 1 && bar.events[0]?.duration === 'fullMeasure')) return bar;
        const occupied = bar.events.reduce((q, e) => addQ(q, eventDurationQ(e, measure.actualSpanQ, intermediate)), zeroQ);
        return compareQ(occupied, span) < 0 ? { ...bar, events: [...bar.events, ...silence(intermediate, subtractQ(span, occupied))] } : bar;
      }),
    })) })) })),
  };
  // Files tie notes that are not neighbours or differ in pitch. The document's own rule decides which
  // ties hold; the others are released so both notes stay.
  const loose = new Set(validateDocument(repaired).filter(diagnostic => diagnostic.code === 'TIE').map(diagnostic => diagnostic.path));
  for (const tie of loose) inventory.add('tie.released', tie, '이웃하지 않거나 음높이가 다른 음을 잇는 붙임줄은 풀어서 읽었습니다.');
  const document = parseScoreDocument(loose.size ? { ...repaired, ties: repaired.ties.filter(tie => !loose.has(tie.id)) } : repaired);
  // The timeline is the one authority on repeats and jumps. What it cannot follow is read straight through.
  try { compileOccurrences(document, { followRepeats: true }); return document; }
  catch (error) {
    if (!(error instanceof DomainError)) throw error;
    inventory.add('repeat.unreadable', 'Score', '반복과 진행 기호를 따라갈 수 없어 처음부터 끝까지 한 번 연주하는 것으로 읽었습니다.');
    return parseScoreDocument({ ...document, measures: document.measures.map(measure => ({ ...measure, repeats: { start: false }, endings: [], jumps: [] })) });
  }
}
