import { CurveDialog } from './Bend';
import type { ArticulationDialogProps } from './Bend';

export function TremoloBar(props: ArticulationDialogProps) {
  return <CurveDialog {...props} mode="tremoloBar" />;
}
