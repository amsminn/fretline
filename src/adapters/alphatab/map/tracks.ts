import { panToController } from '../../pan';
import { model } from '@coderline/alphatab/core';
import type { Staff, Track } from '../../../domain/document';
import type { MappingContext } from './context';
import { engineLimit } from './context';

export function projectTrack(source: Track, index: number, context: MappingContext): model.Track {
  const track = new model.Track();
  track.name = source.name;
  track.shortName = source.name;
  track.playbackInfo.program = source.instrument.program;
  track.playbackInfo.bank = source.instrument.bank;
  // General MIDI channel 10 is reserved for percussion. Channels repeat only after 15 pitched tracks.
  const channel = index % 15;
  track.playbackInfo.primaryChannel = source.instrument.kind === 'percussion' ? 9 : channel >= 9 ? channel + 1 : channel;
  track.playbackInfo.secondaryChannel = track.playbackInfo.primaryChannel;
  if (source.mixer) {
    track.playbackInfo.volume = Math.round(Math.min(1, source.mixer.volume) * 127) / 8;
    track.playbackInfo.balance = panToController(source.mixer.pan) / 8;
    if (source.mixer.volume > 1) engineLimit(context, source.id, 'MIDI volume ends at unity; above-unity gain belongs to the app audio mixer.');
    track.playbackInfo.isMute = source.mixer.mute;
    track.playbackInfo.isSolo = source.mixer.solo;
  }
  track.isVisibleOnMultiTrack = !context.document.layout.hiddenTracks.includes(source.id);
  track.lineBreaks = new Set(context.document.layout.systemBreaks.map(id =>
    context.document.measures.findIndex(measure => measure.id === id) + 1));
  context.identity.tracks.set(source.id, track);
  return track;
}

export function projectStaff(source: Staff, track: Track, context: MappingContext): model.Staff {
  const staff = new model.Staff();
  staff.stringTuning = new model.Tuning('', [...source.tuning]);
  staff.capo = source.capo;
  staff.transpositionPitch = -(track.transposition ?? 0);
  staff.isPercussion = track.instrument.kind === 'percussion';
  const stylesheet = context.document.layout.stylesheet;
  staff.showStandardNotation = stylesheet.showStandard;
  staff.showTablature = stylesheet.showTab;
  switch (source.notationMode) {
    case 'standard':
    case 'drum': staff.showStandardNotation = true; staff.showTablature = false; break;
    case 'tab': staff.showStandardNotation = false; staff.showTablature = true; break;
    case 'both': staff.showStandardNotation = true; staff.showTablature = true; break;
    case 'slash': staff.showStandardNotation = false; staff.showTablature = false; staff.showSlash = true; break;
    case undefined: break;
  }
  context.identity.staves.set(source.id, staff);
  return staff;
}
