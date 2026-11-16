import { model } from '@coderline/alphatab/core';
import { assertNever } from '../../../domain/diagnostics';
import { eventDurationQ } from '../../../domain/event-time';
import type { ScoreEvent } from '../../../domain/notation';
import type { RationalQ } from '../../../domain/rational';
import type { MappingContext } from './context';
import { engineLimit } from './context';
import { projectNote } from './notes';
import { duration, numberQ, ticksQ } from './time';

const dynamics = { ppp: model.DynamicValue.PPP, pp: model.DynamicValue.PP,
  p: model.DynamicValue.P, mp: model.DynamicValue.MP, mf: model.DynamicValue.MF,
  f: model.DynamicValue.F, ff: model.DynamicValue.FF, fff: model.DynamicValue.FFF } as const;
const fades = { in: model.FadeType.FadeIn, out: model.FadeType.FadeOut, swell: model.FadeType.VolumeSwell } as const;

export function projectEvent(input: { readonly event: ScoreEvent; readonly spanQ: RationalQ; readonly nested: boolean },
  voice: model.Voice, context: MappingContext): model.Beat {
  const { event, spanQ } = input;
  const beat = new model.Beat();
  voice.addBeat(beat);
  context.identity.addEvent(event.id, beat);
  beat.overrideDisplayDuration = ticksQ(eventDurationQ(event, spanQ, context.document));
  if (event.duration === 'fullMeasure') beat.duration = model.Duration.Whole;
  else {
    beat.duration = duration(event.duration.base);
    beat.dots = event.duration.dots;
    if (event.duration.base > 256) engineLimit(context, event.id,
      'Exact duration is retained; alphaTab has no note glyph shorter than a 256th.');
    if (!input.nested) for (const id of event.duration.tupletIds) {
      const tuplet = context.document.tuplets.find(t => t.id === id);
      if (!tuplet) throw new RangeError(`Missing tuplet ${id}`);
      beat.tupletNumerator = tuplet.actual;
      beat.tupletDenominator = tuplet.normal;
    }
  }
  if (event.dynamics) beat.dynamics = dynamics[event.dynamics];
  const texts = [...event.annotations ?? []];
  for (const scale of context.document.scales ?? []) {
    if (scale.eventId === event.id) {
      texts.push(`${scale.name} (${scale.root}: ${scale.intervals.join(',')})`);
    }
  }
  if (texts.length) beat.text = texts.join('\n');
  if (event.fade) beat.fade = fades[event.fade];
  if (event.rasgueado) {
    const entry = Object.entries(model.Rasgueado).find(([name]) => name.toLowerCase() === event.rasgueado?.toLowerCase());
    if (entry && typeof entry[1] === 'number') beat.rasgueado = entry[1];
    else engineLimit(context, event.id, `Rasgueado pattern "${event.rasgueado}" is outside alphaTab's fixed pattern enum.`);
  }
  for (const point of event.tremoloBar ?? []) {
    beat.addWhammyBarPoint(new model.BendPoint(numberQ(point.position) * model.BendPoint.MaxPosition,
      numberQ(point.semitones) * 2));
  }
  const lyrics = context.document.lyrics.filter(lyric => lyric.eventId === event.id);
  if (lyrics.length) {
    beat.lyrics = Array.from({ length: Math.max(...lyrics.map(lyric => lyric.verse)) }, () => '');
    for (const lyric of lyrics) {
      beat.lyrics[Math.max(0, lyric.verse - 1)] = lyric.text +
        (lyric.syllabic === 'begin' || lyric.syllabic === 'middle' ? '-' : '');
      if (lyric.extend) engineLimit(context, lyric.id, 'alphaTab stores lyric text per beat but has no melisma extent field.');
    }
  }
  switch (event.kind) {
    case 'spacer': beat.isEmpty = true; break;
    case 'rest': break;
    case 'noteGroup':
      if (event.grace) {
        switch (event.grace.kind) {
          case 'beforeBeat': beat.graceType = model.GraceType.BeforeBeat; break;
          case 'onBeat': beat.graceType = model.GraceType.OnBeat; break;
          default: assertNever(event.grace.kind);
        }
        if (!event.grace.slash) engineLimit(context, event.id, 'alphaTab grace slashing follows its engraving style, not an independent flag.');
      }
      if (event.arpeggio) beat.brushType = event.arpeggio === 'up' ? model.BrushType.ArpeggioUp : model.BrushType.ArpeggioDown;
      if (event.brush) {
        if (event.arpeggio) engineLimit(context, event.id, 'A beat has one engine brushType; brush takes precedence over arpeggio.');
        beat.brushType = event.brush === 'up' ? model.BrushType.BrushUp : model.BrushType.BrushDown;
      }
      if (beat.brushType !== model.BrushType.None) beat.brushDuration = 60;
      for (const note of event.notes) projectNote(note, beat, context);
      break;
    default: assertNever(event);
  }
  return beat;
}
