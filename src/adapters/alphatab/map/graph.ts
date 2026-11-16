import { LayoutMode, model, Settings, SystemsLayoutMode } from '@coderline/alphatab/core';
import { assertNever } from '../../../domain/diagnostics';
import type { Measure, ScoreDocument } from '../../../domain/document';
import { eventDurationQ } from '../../../domain/event-time';
import { addQ, compareQ, subtractQ, zeroQ } from '../../../domain/rational';
import type { Occurrence } from '../../../domain/timeline';
import { ScoreIdentity } from './identity';
import type { MappingContext, ProjectionDiagnostic } from './context';
import { engineLimit } from './context';
import { projectEvent } from './events';
import { projectMeasure } from './measures';
import { projectChords, projectRelations } from './relations';
import { projectAutomations } from './automations';
import { projectStaff, projectTrack } from './tracks';
import { ticksQ } from './time';
import { nestedTuplets } from './tuplets';
import { registerBar, reusableBars } from './reuse';
import type { ProjectionSnapshot } from './reuse';

export type ScoreProjection = {
  readonly score: model.Score;
  readonly settings: Settings;
  readonly identity: ScoreIdentity;
  readonly diagnostics: readonly ProjectionDiagnostic[];
  readonly nestedTuplets: ReturnType<typeof nestedTuplets>;
};
type Row = { readonly measure: Measure; readonly occurrence?: Occurrence };
const clefs = { treble: model.Clef.G2, bass: model.Clef.F4, alto: model.Clef.C3,
  tenor: model.Clef.C4, percussion: model.Clef.Neutral } as const;

/** The optional rows are already compiled by domain/timeline; this builder never interprets repeats. */
export function buildProjection(document: ScoreDocument, occurrences?: readonly Occurrence[], previous?: ProjectionSnapshot): ScoreProjection {
  const context: MappingContext = { document, identity: new ScoreIdentity(), diagnostics: [] };
  const reused = reusableBars(occurrences ? undefined : previous, document);
  const score = new model.Score();
  const settings = new Settings();
  settings.core.includeNoteBounds = true;
  settings.player.enableCursor = false;
  settings.player.enableElementHighlighting = false;
  settings.player.enableUserInteraction = false;
  settings.display.scale = document.layout.scale;
  settings.display.layoutMode = document.layout.view === 'horizontal' ? LayoutMode.Horizontal : LayoutMode.Page;
  settings.display.systemsLayoutMode = SystemsLayoutMode.UseModelLayout;
  const { fontFamily, fontSize } = document.layout.stylesheet;
  const resources = settings.display.resources;
  for (const [element, font] of resources.elementFonts) {
    resources.elementFonts.set(element, new model.Font(fontFamily, font.size * fontSize / 12, font.style, font.weight));
  }
  resources.tablatureFont = new model.Font(fontFamily, fontSize);
  resources.graceFont = new model.Font(fontFamily, fontSize * 0.75);
  resources.numberedNotationFont = new model.Font(fontFamily, fontSize);
  resources.numberedNotationGraceFont = new model.Font(fontFamily, fontSize * 0.75);
  const { metadata } = document;
  score.title = metadata.title;
  score.subTitle = metadata.subtitle;
  score.artist = metadata.artist;
  score.album = metadata.album;
  score.words = metadata.words;
  score.music = metadata.music;
  score.copyright = metadata.copyright;
  score.instructions = metadata.instructions;
  score.notices = metadata.notices.join('\n');
  score.stylesheet.globalDisplayChordDiagramsInScore = document.layout.stylesheet.showChordDiagrams;
  score.stylesheet.globalDisplayChordDiagramsOnTop = document.layout.stylesheet.showChordDiagrams;
  score.stylesheet.tabConfig.rests = { isVisible: true, staffPlacement: model.StaffPlacement.AllStaves };
  // The engine's default second copyright line ("All Rights Reserved - International Copyright Secured") is
  // boilerplate the document does not own and it is stacked by ink height, over the copyright text itself.
  score.style = new model.ScoreStyle();
  score.style.headerAndFooter.set(model.ScoreSubElement.CopyrightSecondLine, new model.HeaderFooterStyle('', false));
  const nested = nestedTuplets(document);
  const nestedEvents = new Set(nested.flatMap(tuplet => tuplet.eventIds));
  const measures = new Map(document.measures.map(measure => [measure.id, measure]));
  const rows: readonly Row[] = occurrences ? occurrences.map(occurrence => {
    const measure = measures.get(occurrence.measureId);
    if (!measure) throw new RangeError(`Occurrence references missing measure ${occurrence.measureId}`);
    return { measure, occurrence };
  }) : document.measures.map(measure => ({ measure }));
  for (const { measure, occurrence } of rows) {
    const master = projectMeasure(measure);
    if (occurrence) {
      master.isRepeatStart = false;
      master.repeatCount = 0;
      master.alternateEndings = 0;
      master.directions = null;
      master.isAnacrusis = true;
      master.tempoAutomations = [];
    }
    score.addMasterBar(master);
    context.identity.measures.set(measure.id, master);
  }
  for (const [trackIndex, sourceTrack] of document.tracks.entries()) {
    const track = projectTrack(sourceTrack, trackIndex, context);
    score.addTrack(track);
    for (const sourceStaff of sourceTrack.staves) {
      const staff = projectStaff(sourceStaff, sourceTrack, context);
      track.addStaff(staff);
      for (const [rowIndex, { measure, occurrence }] of rows.entries()) {
        const retained = reused.get(sourceStaff)?.get(rowIndex);
        if (retained) {
          staff.addBar(retained);
          registerBar(retained, sourceStaff, context);
          continue;
        }
        const bar = new model.Bar();
        bar.clef = clefs[sourceStaff.clef];
        bar.keySignature = measure.key.fifths;
        bar.keySignatureType = measure.key.mode === 'major' ? model.KeySignatureType.Major : model.KeySignatureType.Minor;
        staff.addBar(bar);
        for (const lane of [...sourceStaff.voices].sort((a, b) => a.number - b.number)) {
          const voice = new model.Voice();
          bar.addVoice(voice);
          context.identity.voices.set(lane.id, [...context.identity.voices.get(lane.id) ?? [], voice]);
          const source = lane.bars.find(source => source.measureId === measure.id);
          if (!source) throw new RangeError(`Missing voice bar ${lane.id}:${measure.id}`);
          switch (source.kind) {
            case 'inactive': {
              const empty = new model.Beat();
              empty.isEmpty = lane.number !== 1;
              empty.duration = model.Duration.Whole;
              empty.overrideDisplayDuration = ticksQ(occurrence?.spanQ ?? measure.actualSpanQ);
              voice.addBeat(empty);
              context.identity.addBarSlot({ measureId: measure.id, voiceId: lane.id }, empty);
              break;
            }
            case 'active': {
              let onset = zeroQ;
              for (const event of source.events) {
                const span = eventDurationQ(event, measure.actualSpanQ, document);
                const end = addQ(onset, span);
                const start = occurrence && compareQ(onset, occurrence.measureOffsetQ) < 0 ? occurrence.measureOffsetQ : onset;
                const limit = occurrence ? addQ(occurrence.measureOffsetQ, occurrence.spanQ) : measure.actualSpanQ;
                const clippedEnd = compareQ(end, limit) > 0 ? limit : end;
                const graceInRange = compareQ(span, zeroQ) === 0 && compareQ(onset, start) >= 0 && compareQ(onset, limit) < 0;
                if (compareQ(start, clippedEnd) < 0 || graceInRange) {
                  const beat = projectEvent({ event, spanQ: measure.actualSpanQ, nested: nestedEvents.has(event.id) }, voice, context);
                  if (occurrence && !graceInRange) beat.overrideDisplayDuration = ticksQ(subtractQ(clippedEnd, start));
                }
                onset = end;
              }
              break;
            }
            default: assertNever(source);
          }
        }
      }
    }
  }
  if (!occurrences) {
    projectRelations(context);
    projectChords(context);
  }
  score.finish(settings);
  if (!occurrences) projectAutomations(context);
  // finish derives most links; explicit authored relationship endpoints remain authoritative.
  if (!occurrences) projectRelations(context);
  for (const id of document.layout.pageBreaks) engineLimit(context, id, 'alphaTab exposes system line breaks, not forced page breaks.');
  for (const spacing of document.layout.eventSpacing ?? []) engineLimit(context, spacing.eventId,
    'alphaTab exposes bar displayWidth, not independent beat spacing overrides.');
  return { score, settings, identity: context.identity, diagnostics: context.diagnostics, nestedTuplets: nested };
}
