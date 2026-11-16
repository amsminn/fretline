import { model } from '@coderline/alphatab/core';
import { assertNever } from '../../../domain/diagnostics';
import type { Note, Technique } from '../../../domain/notation';
import { engineLimit } from './context';
import type { MappingContext } from './context';
import { duration, numberQ } from './time';

const harmonic = {
  natural: model.HarmonicType.Natural, artificial: model.HarmonicType.Artificial,
  pinch: model.HarmonicType.Pinch, tap: model.HarmonicType.Tap,
  semi: model.HarmonicType.Semi, feedback: model.HarmonicType.Feedback,
} as const;
const fingers: Readonly<Record<string, model.Fingers>> = {
  '': model.Fingers.Unknown, '0': model.Fingers.Thumb, T: model.Fingers.Thumb,
  p: model.Fingers.Thumb, '1': model.Fingers.IndexFinger, i: model.Fingers.IndexFinger,
  '2': model.Fingers.MiddleFinger, m: model.Fingers.MiddleFinger,
  '3': model.Fingers.AnnularFinger, a: model.Fingers.AnnularFinger,
  '4': model.Fingers.LittleFinger, c: model.Fingers.LittleFinger,
};

export function projectTechniques(source: Note, note: model.Note, context: MappingContext): void {
  for (const technique of source.techniques) {
    switch (technique.kind) {
      case 'bend':
        for (const point of technique.points) note.addBendPoint(new model.BendPoint(
          numberQ(point.position) * model.BendPoint.MaxPosition, numberQ(point.semitones) * 2));
        break;
      case 'harmonic':
        note.harmonicType = harmonic[technique.style];
        note.harmonicValue = numberQ(technique.fret);
        break;
      case 'slide': projectSlide(technique, note); break;
      case 'legato': note.isHammerPullOrigin = true; break;
      case 'trill':
        note.trillValue = technique.fret + note.stringTuning;
        note.trillSpeed = duration(technique.base);
        break;
      case 'tremoloPicking': note.beat.tremoloSpeed = duration(technique.base); break;
      case 'fingering':
        note.leftHandFinger = fingers[technique.left] ?? model.Fingers.Unknown;
        note.rightHandFinger = fingers[technique.right] ?? model.Fingers.Unknown;
        if (fingers[technique.left] === undefined || fingers[technique.right] === undefined) {
          engineLimit(context, source.id, 'The authored fingering label has no alphaTab finger enum.');
        }
        break;
      case 'vibrato': note.vibrato = technique.strength === 'wide' ? model.VibratoType.Wide : model.VibratoType.Slight; break;
      case 'pickStroke': note.beat.pickStroke = technique.direction === 'up' ? model.PickStroke.Up : model.PickStroke.Down; break;
      case 'palmMute': note.isPalmMute = true; break;
      case 'letRing': note.isLetRing = true; break;
      case 'staccato': note.isStaccato = true; break;
      case 'accent': note.accentuated = model.AccentuationType.Normal; break;
      case 'heavyAccent': note.accentuated = model.AccentuationType.Heavy; break;
      case 'dead': note.isDead = true; break;
      case 'ghost': note.isGhost = true; break;
      case 'tap': note.beat.tap = true; break;
      case 'slap': note.beat.slap = true; break;
      case 'pop': note.beat.pop = true; break;
      default: assertNever(technique);
    }
  }
}

function projectSlide(technique: Extract<Technique, { readonly kind: 'slide' }>, note: model.Note): void {
  switch (technique.style) {
    case 'shift': note.slideOutType = model.SlideOutType.Shift; break;
    case 'legato': note.slideOutType = model.SlideOutType.Legato; break;
    case 'inAbove': note.slideInType = model.SlideInType.IntoFromAbove; break;
    case 'inBelow': note.slideInType = model.SlideInType.IntoFromBelow; break;
    case 'outUp': note.slideOutType = model.SlideOutType.OutUp; break;
    case 'outDown': note.slideOutType = model.SlideOutType.OutDown; break;
    default: assertNever(technique.style);
  }
}
