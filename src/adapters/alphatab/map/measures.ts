import { model } from '@coderline/alphatab/core';
import { assertNever } from '../../../domain/diagnostics';
import type { Measure } from '../../../domain/document';
import { numberQ } from './time';

export function projectMeasure(measure: Measure): model.MasterBar {
  const bar = new model.MasterBar();
  bar.timeSignatureNumerator = measure.meter.beats;
  bar.timeSignatureDenominator = measure.meter.unit;
  bar.isAnacrusis = numberQ(measure.actualSpanQ) !== measure.meter.beats * 4 / measure.meter.unit;
  bar.isFreeTime = measure.freeTime ?? false;
  bar.isRepeatStart = measure.repeats.start;
  bar.repeatCount = measure.repeats.totalPlays ?? 0;
  bar.alternateEndings = measure.endings.reduce((mask, pass) => mask | (1 << (pass - 1)), 0);
  bar.tempoAutomations = measure.tempoEvents.map(tempo =>
    model.Automation.buildTempoAutomation(tempo.transition === 'linear',
      numberQ(tempo.offsetQ) / (measure.meter.beats * 4 / measure.meter.unit), tempo.bpm, 2));
  if (measure.section) {
    const section = new model.Section();
    section.text = measure.section.name;
    section.marker = measure.section.letter;
    bar.section = section;
  }
  for (const jump of measure.jumps) {
    switch (jump.kind) {
      case 'segno': bar.addDirection(model.Direction.TargetSegno); break;
      case 'coda': bar.addDirection(model.Direction.TargetCoda); break;
      case 'fine': bar.addDirection(model.Direction.TargetFine); break;
      case 'toCoda': bar.addDirection(model.Direction.JumpDaCoda); break;
      case 'dc':
        switch (jump.until) {
          case 'end': bar.addDirection(model.Direction.JumpDaCapo); break;
          case 'fine': bar.addDirection(model.Direction.JumpDaCapoAlFine); break;
          case 'coda': bar.addDirection(model.Direction.JumpDaCapoAlCoda); break;
          default: assertNever(jump.until);
        }
        break;
      case 'ds':
        switch (jump.until) {
          case 'end': bar.addDirection(model.Direction.JumpDalSegno); break;
          case 'fine': bar.addDirection(model.Direction.JumpDalSegnoAlFine); break;
          case 'coda': bar.addDirection(model.Direction.JumpDalSegnoAlCoda); break;
          default: assertNever(jump.until);
        }
        break;
      default: assertNever(jump);
    }
  }
  return bar;
}
