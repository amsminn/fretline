import { useState } from 'react';
import { useT } from '../i18n/react';
import type { MessageKey } from '../i18n';
import { paperNames, paperPresets, paperLimitsMm, parsePageSetup, PrintOptionError, scaleLimits } from '../print/options';
import type { MarginsMm, Orientation, PageSetup as PageSetupValue, PaperName } from '../print/options';
import { Button } from '../ui/Button';
import { NumberField } from '../ui/NumberField';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/Select';
import { ToggleGroup, ToggleGroupItem } from '../ui/Toggle';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/Dialog';

const paperLabels: Readonly<Record<PaperName, string>> = {
  A4: 'A4 (210 × 297 mm)', A3: 'A3 (297 × 420 mm)', A5: 'A5 (148 × 210 mm)', B5: 'B5 (176 × 250 mm)',
  Letter: 'Letter (8.5 × 11 in)', Legal: 'Legal (8.5 × 14 in)',
};
const marginSides = ['top', 'right', 'bottom', 'left'] as const satisfies readonly (keyof MarginsMm)[];
const marginLabels = { top: 'io.pageSetup.top', right: 'io.pageSetup.right', bottom: 'io.pageSetup.bottom', left: 'io.pageSetup.left' } as const satisfies Readonly<Record<keyof MarginsMm, MessageKey>>;

/** Page setup is a draft until Apply; an invalid combination is rejected with the reason and nothing changes. */
export function PageSetup({ initial, onApply, onClose }: {
  readonly initial: PageSetupValue; readonly onApply: (setup: PageSetupValue) => void; readonly onClose: () => void;
}) {
  const t = useT();
  const [paperName, setPaperName] = useState<PaperName | 'custom'>(initial.paper.name);
  const [custom, setCustom] = useState(initial.paper.name === 'custom' ? { widthMm: initial.paper.widthMm, heightMm: initial.paper.heightMm } : { ...paperPresets.A4 });
  const [orientation, setOrientation] = useState<Orientation>(initial.orientation);
  const [margins, setMargins] = useState<MarginsMm>(initial.marginsMm);
  const [scalePercent, setScalePercent] = useState(Math.round(initial.scale * 100));
  const [error, setError] = useState<string | null>(null);
  const draft: PageSetupValue = { paper: paperName === 'custom' ? { name: 'custom', ...custom } : { name: paperName }, orientation, marginsMm: margins, scale: scalePercent / 100 };
  const apply = (): void => {
    try { onApply(parsePageSetup(draft)); }
    catch (failure) {
      if (!(failure instanceof PrintOptionError)) throw failure;
      setError(failure.message);
    }
  };
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent data-testid="page-setup-dialog">
      <DialogHeader>
        <DialogTitle>{t('io.pageSetup.title')}</DialogTitle>
        <DialogDescription>{t('io.pageSetup.description')}</DialogDescription>
      </DialogHeader>
      <form noValidate className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); apply(); }}>
        <label className="flex items-center justify-between gap-3 text-xs">{t('io.pageSetup.paper')}
          <Select value={paperName} onValueChange={value => {
            const chosen = [...paperNames, 'custom' as const].find(name => name === value);
            if (chosen) setPaperName(chosen);
          }}>
            <SelectTrigger aria-label={t('io.pageSetup.paper')} className="w-56"><SelectValue /></SelectTrigger>
            <SelectContent>{[...paperNames, 'custom' as const].map(name => <SelectItem key={name} value={name}>{name === 'custom' ? t('io.pageSetup.custom') : paperLabels[name]}</SelectItem>)}</SelectContent>
          </Select>
        </label>
        {paperName === 'custom' && <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-xs">{t('io.pageSetup.width')}
            <NumberField label={t('io.pageSetup.widthField')} unit="mm" value={custom.widthMm} min={paperLimitsMm.min} max={paperLimitsMm.max} onValueChange={widthMm => setCustom({ ...custom, widthMm })} />
          </label>
          <label className="flex flex-col gap-1 text-xs">{t('io.pageSetup.height')}
            <NumberField label={t('io.pageSetup.heightField')} unit="mm" value={custom.heightMm} min={paperLimitsMm.min} max={paperLimitsMm.max} onValueChange={heightMm => setCustom({ ...custom, heightMm })} />
          </label>
        </div>}
        <div className="flex items-center justify-between gap-3 text-xs">{t('io.pageSetup.orientation')}
          <ToggleGroup type="single" value={orientation} aria-label={t('io.pageSetup.orientationGroup')} onValueChange={value => { if (value === 'portrait' || value === 'landscape') setOrientation(value); }}>
            <ToggleGroupItem value="portrait" aria-label={t('io.image.portrait')}>{t('io.image.portrait')}</ToggleGroupItem>
            <ToggleGroupItem value="landscape" aria-label={t('io.image.landscape')}>{t('io.image.landscape')}</ToggleGroupItem>
          </ToggleGroup>
        </div>
        <fieldset className="grid grid-cols-4 gap-2 border-t border-border pt-3">
          <legend className="text-xs text-muted">{t('io.pageSetup.margins')}</legend>
          {marginSides.map(side => <label key={side} className="flex flex-col gap-1 text-xs">{marginLabels[side]}
            <NumberField label={t('io.pageSetup.margin', { side: t(marginLabels[side]) })} unit="mm" value={margins[side]} min={0} max={200} step={0.5} onValueChange={value => setMargins({ ...margins, [side]: value })} />
          </label>)}
        </fieldset>
        <label className="flex items-center justify-between gap-3 border-t border-border pt-3 text-xs">{t('io.pageSetup.scale', { min: scaleLimits.min * 100, max: scaleLimits.max * 100 })}
          <NumberField label={t('io.pageSetup.scaleField')} unit="%" value={scalePercent} min={scaleLimits.min * 100} max={scaleLimits.max * 100} step={5} onValueChange={setScalePercent} />
        </label>
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>{t('io.cancel')}</Button>
          <Button type="submit" variant="primary">{t('io.apply')}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
