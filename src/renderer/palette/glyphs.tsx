import type { ComponentType, ReactNode } from 'react';

/**
 * Original 16 px music glyphs for the editing palette. Every shape is drawn here in
 * currentColor so hover/pressed/disabled tokens apply; nothing is traced from third-party artwork.
 */
export type IconComponent = ComponentType<{ readonly className?: string }>;

const glyph = (children: ReactNode): IconComponent => {
  const Glyph: IconComponent = ({ className }) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      className={className}>{children}</svg>
  );
  return Glyph;
};
const Head = ({ x, y, hollow = false }: { readonly x: number; readonly y: number; readonly hollow?: boolean }) =>
  <ellipse cx={x} cy={y} rx={2.3} ry={1.6} transform={`rotate(-22 ${x} ${y})`} fill={hollow ? 'none' : 'currentColor'} stroke="currentColor" strokeWidth={hollow ? 1.2 : 0} />;
const Stem = ({ x, y, h = 7 }: { readonly x: number; readonly y: number; readonly h?: number }) => <path d={`M${x + 2} ${y}V${y - h}`} />;
const Flag = ({ x, y }: { readonly x: number; readonly y: number }) => <path d={`M${x + 2} ${y - 7}c2 1.5 3 3 2 5.5`} />;
const Note = ({ x = 6, y = 11.5, flag = false, hollow = false }: { readonly x?: number; readonly y?: number; readonly flag?: boolean; readonly hollow?: boolean }) =>
  <><Head x={x} y={y} hollow={hollow} /><Stem x={x} y={y} />{flag && <Flag x={x} y={y} />}</>;
const Text = ({ children, size = 8, x = 8, y = 11, weight = 600 }: { readonly children: string; readonly size?: number; readonly x?: number; readonly y?: number; readonly weight?: number }) =>
  <text x={x} y={y} textAnchor="middle" fontSize={size} fontWeight={weight} fontFamily="var(--font-ui)" fill="currentColor" stroke="none">{children}</text>;
const Arc = ({ d }: { readonly d: string }) => <path d={d} />;
const Wave = ({ y = 8, amp = 1.6 }: { readonly y?: number; readonly amp?: number }) =>
  <path d={`M2 ${y}q1.5 -${amp * 2} 3 0t3 0t3 0t3 0`} />;

const digit = (n: number): IconComponent => glyph(<><rect x={3} y={2.5} width={10} height={11} rx={1.5} /><Text size={8} y={11}>{String(n)}</Text></>);

export const paletteIcons: Readonly<Record<string, IconComponent>> = {
  'note.voice.1': digit(1), 'note.voice.2': digit(2), 'note.voice.3': digit(3), 'note.voice.4': digit(4),
  'note.multivoice': glyph(<><Head x={4.5} y={10} /><Stem x={4.5} y={10} h={6} /><Head x={11} y={6} /><path d="M9 6v6" /></>),
  'section.lyrics': glyph(<><Head x={7} y={5} /><Stem x={7} y={5} h={3.5} /><path d="M3 10.5h10M3 13.5h7" /></>),
  'section.chord': glyph(<><path d="M4 3v10M8 3v10M12 3v10M4 3h8M4 6.5h8M4 10h8" /><circle cx={8} cy={8.25} r={1.3} fill="currentColor" stroke="none" /><circle cx={12} cy={4.75} r={1.3} fill="currentColor" stroke="none" /></>),
  'section.text': glyph(<><Text size={10} y={10.5} weight={700}>T</Text><path d="M4 13.5h8" /></>),
  'section.edit': glyph(<><rect x={2.5} y={2.5} width={11} height={11} rx={1} /><Text size={8} y={11}>A</Text></>),
  'bar.meter': glyph(<><Text size={7} y={7.5} weight={700}>4</Text><Text size={7} y={14.5} weight={700}>4</Text><path d="M5 8.4h6" strokeWidth={1} /></>),
  'bar.key': glyph(<path d="M6 2.5v11M10 2v11M3.5 6.5l9-2M3.5 11l9-2" />),
  'bar.tempo': glyph(<><Head x={4} y={11} /><Stem x={4} y={11} h={7} /><path d="M9.5 7h4M9.5 10h4" /></>),
  'bar.repeatOpen': glyph(<><path d="M3 2.5v11" strokeWidth={2.2} /><path d="M6 2.5v11" /><circle cx={10} cy={6} r={1.2} fill="currentColor" stroke="none" /><circle cx={10} cy={10} r={1.2} fill="currentColor" stroke="none" /></>),
  'bar.repeatClose': glyph(<><path d="M13 2.5v11" strokeWidth={2.2} /><path d="M10 2.5v11" /><circle cx={6} cy={6} r={1.2} fill="currentColor" stroke="none" /><circle cx={6} cy={10} r={1.2} fill="currentColor" stroke="none" /></>),
  'bar.endings': glyph(<><path d="M2.5 13V4h11" /><Text size={7} x={8.5} y={12}>1.</Text></>),
  'bar.directions': glyph(<><circle cx={8} cy={8} r={3.5} /><path d="M8 2v12M2 8h12" /></>),
  'bar.pickup': glyph(<><path d="M3 2.5v11" /><Head x={10} y={11.5} /><Stem x={10} y={11.5} h={6} /></>),
  'bar.freeTime': glyph(<><Text size={7} y={7.5} weight={700}>4</Text><Text size={7} y={14.5} weight={700}>4</Text><path d="M3.5 13.5l9-11" strokeWidth={1.6} /></>),
  'note.durationShorter': glyph(<><Note x={5} flag /><path d="M11 5h3M12.5 3.5v3" /></>),
  'note.durationLonger': glyph(<><Note x={5} hollow /><path d="M11 5h3" /></>),
  'note.dot': glyph(<><Note x={5} /><circle cx={11} cy={11.5} r={1.2} fill="currentColor" stroke="none" /></>),
  'note.tuplet': glyph(<><path d="M2.5 7V4h3M13.5 7V4h-3" /><Text size={7} y={6.5}>3</Text><Head x={4} y={12.5} /><Head x={12} y={12.5} /></>),
  'note.tie': glyph(<><Head x={4} y={7} /><Head x={12} y={7} /><Arc d="M4 10q4 4 8 0" /></>),
  'note.rest': glyph(<path d="M6 2.5l3.5 3.5-3 3 3.5 3.5c-2-1-3.5-.5-3.5 1.5" />),
  'note.grace': glyph(<><Head x={4} y={9.5} /><Stem x={4} y={9.5} h={5} /><path d="M4.5 6.5l3-2" /><Head x={11} y={11.5} /><Stem x={11} y={11.5} /></>),
  'note.graceOnBeat': glyph(<><Head x={4} y={9.5} /><Stem x={4} y={9.5} h={5} /><path d="M4.5 6.5l3-2" /><Head x={11} y={11.5} /><Stem x={11} y={11.5} /><path d="M11 14.5h4" strokeDasharray="1.2 1.4" /></>),
  'note.tieBeat': glyph(<><path d="M4 13V5M12 13V5" /><Arc d="M4 4q4 -3.5 8 0" /><Head x={2.5} y={13} /><Head x={10.5} y={13} /></>),
  'note.moveVoice': glyph(<><Head x={5} y={8} /><path d="M11 3v10M8.5 5.5L11 3l2.5 2.5M8.5 10.5L11 13l2.5-2.5" /></>),
  'bar.rebar': glyph(<><path d="M8 2.5v11" strokeWidth={2} /><path d="M2 8h12M4 6l-2 2 2 2M12 6l2 2-2 2" /></>),
  'effects.bend': glyph(<><path d="M3 13.5q0-8 9-8" /><path d="M9.5 3l3 2.5-3 2.5" /></>),
  'effects.hammerPull': glyph(<><Head x={4} y={11} /><Head x={12} y={11} /><Arc d="M4 8q4 -4 8 0" /><Text size={6} y={5.5}>H</Text></>),
  'effects.slide': glyph(<><Head x={4} y={11.5} /><Head x={12} y={6} /><path d="M6 10.5l4.5-3.5" /></>),
  'effects.palmMute': glyph(<Text size={7} y={10.5} weight={700}>P.M.</Text>),
  'effects.letRing': glyph(<><Head x={4} y={9} /><path d="M6.5 6.5h7" strokeDasharray="1.6 1.6" /><path d="M13.5 5v3" /></>),
  'effects.vibrato': glyph(<Wave />),
  'effects.harmonic': glyph(<><path d="M5.5 8.5l2.5-2 2.5 2-2.5 2z" /><path d="M10.5 8.5V2.5" /></>),
  'effects.dead': glyph(<><path d="M4 9.5l4 4M8 9.5l-4 4" /><path d="M8 11.5V4.5" /></>),
  'effects.tap': glyph(<Text size={10} y={11.5} weight={700}>T</Text>),
  'effects.slap': glyph(<Text size={10} y={11.5} weight={700}>S</Text>),
  'effects.pop': glyph(<Text size={10} y={11.5} weight={700}>P</Text>),
  'effects.accent': glyph(<path d="M3 4.5l10 3.5-10 3.5" strokeWidth={1.8} />),
  'effects.staccato': glyph(<><Head x={7} y={11.5} /><Stem x={7} y={11.5} h={5} /><circle cx={7} cy={3} r={1.2} fill="currentColor" stroke="none" /></>),
  'effects.trill': glyph(<><Text size={7} x={5.5} y={9}>tr</Text><path d="M9 7.5q1 -2 2 0t2 0t2 0" /></>),
  'effects.tremoloPicking': glyph(<><Head x={5} y={12} /><Stem x={5} y={12} h={9} /><path d="M4.5 6l5-2M4.5 8.5l5-2M4.5 11l5-2" /></>),
  'effects.tremoloBar': glyph(<path d="M2.5 5l4 7 1.5-4 1.5 4 4-7" />),
  'effects.ghost': glyph(<><path d="M5 4.5q-1.8 3.5 0 7M11 4.5q1.8 3.5 0 7" /><Head x={8} y={8} /></>),
  'effects.legato': glyph(<><Head x={4} y={11} /><Head x={12} y={11} /><Arc d="M4 8q4 -4.5 8 0" /></>),
  'effects.brushDown': glyph(<><path d="M8 2q-2 2 0 4t0 4t0 3" /><path d="M5.5 11L8 13.5 10.5 11" /></>),
  'effects.brushUp': glyph(<><path d="M8 14q-2 -2 0-4t0-4t0-3" /><path d="M5.5 5L8 2.5 10.5 5" /></>),
  'effects.pickDown': glyph(<path d="M4 12V4h8v8" strokeWidth={1.8} />),
  'effects.pickUp': glyph(<path d="M4 3.5l4 9 4-9" strokeWidth={1.8} />),
  'effects.rasgueado': glyph(<><Text size={8} y={8.5} weight={700}>R</Text><Wave y={12.5} amp={1} /></>),
  'effects.fadeIn': glyph(<path d="M13 3.5L3 8l10 4.5" />),
  'effects.fadeOut': glyph(<path d="M3 3.5L13 8 3 12.5" />),
  'effects.fingering': glyph(<><path d="M5 13.5V7.5M8 13.5V4.5M11 13.5V6.5" /><path d="M3.5 13.5h9" /></>),
  'effects.sustainPedal': glyph(<Text size={7} y={10.5} weight={700}>Ped.</Text>),
  'effects.audioSettings': glyph(<><path d="M3 5h10M3 8h10M3 11h10" /><circle cx={6} cy={5} r={1.4} fill="currentColor" stroke="none" /><circle cx={10.5} cy={8} r={1.4} fill="currentColor" stroke="none" /><circle cx={7.5} cy={11} r={1.4} fill="currentColor" stroke="none" /></>),
  'effects.palmMuteBeat': glyph(<><Text size={7} y={9} weight={700}>P.M.</Text><path d="M3 12.5h10" strokeDasharray="1.6 1.6" /></>),
};
