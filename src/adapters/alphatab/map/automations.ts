import { panToController } from '../../pan';
import { model } from '@coderline/alphatab/core';
import { assertNever } from '../../../domain/diagnostics';
import type { MappingContext } from './context';
import { engineLimit } from './context';
import { numberQ, ticksQ } from './time';

export function projectAutomations(context: MappingContext): void {
  for (const source of context.document.automations) {
    const track = context.identity.tracks.get(source.trackId);
    const master = context.identity.measures.get(source.measureId);
    const measure = context.document.measures.find(m => m.id === source.measureId);
    if (!track || !master || !measure) throw new RangeError(`Missing automation location ${source.id}`);
    const bar = track.staves[0]?.bars[master.index];
    if (!bar) throw new RangeError(`Missing automation bar ${source.id}`);
    const ratio = numberQ(source.offsetQ) / (measure.meter.beats * 4 / measure.meter.unit);
    const automation = new model.Automation();
    automation.ratioPosition = ratio;
    automation.value = source.value;
    switch (source.kind) {
      case 'volume':
        automation.type = model.AutomationType.Volume;
        automation.value = Math.round(Math.min(1, source.value) * 127) / 8;
        if (source.value > 1) engineLimit(context, source.id, 'MIDI volume ends at unity; above-unity gain belongs to the app audio mixer.');
        break;
      case 'pan': automation.type = model.AutomationType.Balance; automation.value = panToController(source.value) / 8; break;
      case 'program': automation.type = model.AutomationType.Instrument; break;
      case 'sustain': {
        const pedal = new model.SustainPedalMarker();
        pedal.ratioPosition = ratio;
        pedal.pedalType = source.value >= 0.5 ? model.SustainPedalMarkerType.Down : model.SustainPedalMarkerType.Up;
        pedal.bar = bar;
        bar.sustainPedals.push(pedal);
        engineLimit(context, source.id, 'Sustain pedal notation is projected; alphaTab 1.9 MIDI generation does not emit pedal controllers.');
        continue;
      }
      case 'expression':
      case 'pitchBend':
        engineLimit(context, source.id, `alphaTab AutomationType has no ${source.kind} controller.`);
        continue;
      default: assertNever(source.kind);
    }
    // Automation ratio is global to its bar. Associate it with the containing beat.
    const beat = bar.voices.flatMap(voice => voice.beats).find(beat =>
      beat.displayStart <= ticksQ(source.offsetQ) && beat.displayEnd > ticksQ(source.offsetQ));
    if (!beat) throw new RangeError(`Automation ${source.id} has no containing beat`);
    if (beat.displayStart !== ticksQ(source.offsetQ)) engineLimit(context, source.id,
      'alphaTab schedules volume/pan/program at the containing beat onset, not the automation ratio.');
    beat.automations.push(automation);
  }
}
