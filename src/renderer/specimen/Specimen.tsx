import { Copy, Pause, Play, Repeat, Save, Scissors, SkipBack, Square, Volume2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Button, Checkbox, ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
  IconButton, Input, Knob, NumberField, Popover, PopoverContent, PopoverTrigger, ScrollArea, Select, SelectContent, SelectItem,
  SelectTrigger, SelectValue, Separator, Slider, Switch, Tabs, TabsContent, TabsList, TabsTrigger, Toast, ToastAction,
  ToastDescription, ToastProvider, ToastTitle, ToastViewport, ToggleButton, ToggleGroup, ToggleGroupItem, TooltipProvider,
} from '../ui';
import { densityTokens, semanticTokens, themes, typeScale } from './catalog';
import { PaletteSpecimen } from './PaletteSpecimen';
import type { Theme } from './catalog';

function Section({ title, states: withStates = false, children }: { readonly title: string; readonly states?: boolean; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">{title}</h2>
      {withStates && (
        <div className="grid grid-cols-[8rem_repeat(5,minmax(0,1fr))] gap-2 border-b border-border pb-1 text-2xs font-medium uppercase tracking-wide text-subtle">
          <span>primitive</span>{states.map(state => <span key={state}>{state}</span>)}
        </div>
      )}
      {children}
    </section>
  );
}

function Swatch({ token }: { readonly token: (typeof semanticTokens)[number] }) {
  const isShadow = token.startsWith('shadow-');
  return (
    <div data-token={token} className="flex items-center gap-2 rounded-md border border-border bg-panel-raised p-1.5">
      <span
        aria-hidden="true"
        className="size-7 shrink-0 rounded-sm border border-border"
        style={isShadow ? { boxShadow: `var(--${token})`, background: 'var(--bg-panel)' } : { background: `var(--${token})` }}
      />
      <code className="truncate font-mono text-2xs text-muted">--{token}</code>
    </div>
  );
}

const states = ['default', 'hover', 'pressed', 'focus-visible', 'disabled'] as const;
type State = (typeof states)[number];
const forced = (state: State): string => (state === 'default' || state === 'disabled' ? '' : state === 'pressed' ? 'spec-active' : `spec-${state}`);

function StateRow({ label, render }: { readonly label: string; readonly render: (state: State) => ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_repeat(5,minmax(0,1fr))] items-center gap-2">
      <span className="text-xs text-muted">{label}</span>
      {states.map(state => <div key={state} data-state-label={state} className={forced(state)}>{render(state)}</div>)}
    </div>
  );
}

export function Specimen() {
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.dataset['theme'] === 'light' ? 'light' : 'dark'));
  const [tempo, setTempo] = useState(120);
  const [pan, setPan] = useState(0);
  const [volume, setVolume] = useState([80]);
  const [toastOpen, setToastOpen] = useState(false);
  useEffect(() => {
    if (theme === 'light') document.documentElement.dataset['theme'] = 'light';
    else delete document.documentElement.dataset['theme'];
  }, [theme]);
  return (
    <TooltipProvider>
      <ToastProvider>
        <ScrollArea className="h-full bg-app text-fg">
          <div data-testid="specimen-ready" className="mx-auto flex max-w-[1320px] flex-col gap-8 p-6">
            <header className="flex items-center justify-between gap-4">
              <div>
                <h1 className="text-xl font-semibold">Fretline 디자인 기반 Specimen</h1>
                <p className="text-xs text-muted">토큰, 타입 스케일, 밀도, primitive의 모든 상태. 테마: {theme}</p>
              </div>
              <ToggleGroup type="single" value={theme} onValueChange={value => { if (value === 'dark' || value === 'light') setTheme(value); }} aria-label="테마">
                {themes.map(item => <ToggleGroupItem key={item} value={item} data-testid={`theme-${item}`}>{item}</ToggleGroupItem>)}
              </ToggleGroup>
            </header>

            <Section title="Semantic tokens">
              <div className="grid grid-cols-6 gap-2">{semanticTokens.map(token => <Swatch key={token} token={token} />)}</div>
            </Section>

            <Section title="Type scale">
              <div className="flex flex-col gap-1 rounded-md border border-border bg-panel p-3">
                {typeScale.map(row => (
                  <div key={row.utility} className="grid grid-cols-[6rem_3rem_1fr] items-baseline gap-3">
                    <code className="font-mono text-2xs text-muted">{row.utility}</code>
                    <span className="font-mono text-2xs tabular-nums text-subtle">{row.px}px</span>
                    <span className={row.utility}>기타 연주자 Fretline 0123456789 — {row.use}</span>
                  </div>
                ))}
                <div className="mt-2 font-mono text-sm tabular-nums">JetBrains Mono: 120 BPM 4/4 ♩=120 00:01:23.456</div>
              </div>
            </Section>

            <Section title="Density, radius, motion">
              <div className="grid grid-cols-5 gap-2">
                {densityTokens.map(([name, value]) => (
                  <div key={name} className="flex items-center justify-between rounded-md border border-border bg-panel-raised px-2 py-1 font-mono text-2xs">
                    <span className="text-muted">{name}</span><span className="tabular-nums">{value}</span>
                  </div>
                ))}
              </div>
              <div className="flex items-end gap-3">
                <div className="flex h-control-compact items-center rounded-md border border-border bg-panel-raised px-2 text-2xs">22 compact</div>
                <div className="flex h-control-default items-center rounded-md border border-border bg-panel-raised px-2 text-xs">26 default</div>
                <div className="flex h-control-toolbar items-center rounded-md border border-border bg-panel-raised px-3 text-sm">32 toolbar</div>
                <div className="flex h-control-default items-center rounded-sm border border-border px-2 text-xs">radius 2</div>
                <div className="flex h-control-default items-center rounded-md border border-border px-2 text-xs">radius 4</div>
                <div className="flex h-control-default items-center rounded-lg border border-border px-2 text-xs">radius 6</div>
              </div>
            </Section>

            <Section title="Score paper and selection tokens">
              <div className="relative h-28 overflow-hidden rounded-md border border-border bg-paper text-paper-ink">
                {[0, 1, 2, 3, 4, 5].map(line => <div key={line} className="absolute inset-x-6 h-px bg-paper-staff" style={{ top: 28 + line * 10 }} />)}
                <div className="absolute inset-y-4 left-32 w-40 rounded-sm bg-selection-fill ring-1 ring-selection-edge" />
                <div className="absolute inset-y-2 left-80 w-56 bg-loop-range" />
                <div className="absolute inset-y-2 left-52 w-0.5 bg-playback-cursor" />
                <span className="absolute left-6 top-2 font-mono text-2xs">paper / paper-ink / paper-staff · selection · playback-cursor · loop-range</span>
              </div>
              <div className="flex items-center gap-3 rounded-md bg-lcd-bg px-3 py-1 font-mono text-sm tabular-nums text-lcd-fg">
                <span>♩ = 120</span><span>4/4</span><span>00:00:00.000</span><span>Bar 1</span>
              </div>
            </Section>

            <Section title="Button, IconButton, Toggle" states>
              <StateRow label="Button default" render={state => <Button disabled={state === 'disabled'}>저장</Button>} />
              <StateRow label="Button primary" render={state => <Button variant="primary" disabled={state === 'disabled'}>확인</Button>} />
              <StateRow label="Button ghost" render={state => <Button variant="ghost" disabled={state === 'disabled'}>취소</Button>} />
              <StateRow label="Button danger" render={state => <Button variant="danger" disabled={state === 'disabled'}>삭제</Button>} />
              <StateRow label="IconButton" render={state => <IconButton label="재생" shortcut="Space" disabled={state === 'disabled'}><Play /></IconButton>} />
              <StateRow label="IconButton toolbar" render={state => <IconButton label="저장" shortcut="⌘S" variant="default" size="toolbar" disabled={state === 'disabled'}><Save /></IconButton>} />
              <StateRow label="Toggle (on)" render={state => <ToggleButton pressed aria-label="반복" disabled={state === 'disabled'}><Repeat /></ToggleButton>} />
              <StateRow label="Toggle (off)" render={state => <ToggleButton pressed={false} aria-label="반복" disabled={state === 'disabled'}><Repeat /></ToggleButton>} />
              <div className="flex items-center gap-4">
                <ToggleGroup type="single" defaultValue="play" aria-label="트랜스포트">
                  <ToggleGroupItem value="back" aria-label="처음으로"><SkipBack /></ToggleGroupItem>
                  <ToggleGroupItem value="play" aria-label="재생"><Play /></ToggleGroupItem>
                  <ToggleGroupItem value="pause" aria-label="일시정지"><Pause /></ToggleGroupItem>
                  <ToggleGroupItem value="stop" aria-label="정지"><Square /></ToggleGroupItem>
                </ToggleGroup>
                <Separator orientation="vertical" className="h-6" />
                <div className="flex gap-1">{Array.from({ length: 12 }, (_, index) => <span key={index} className={`size-4 rounded-sm bg-track-${index + 1}`} aria-label={`트랙 ${index + 1}`} />)}</div>
              </div>
            </Section>

            <Section title="편집 팔레트 격자">
              <PaletteSpecimen />
            </Section>

            <Section title="Input, NumberField, Select" states>
              <StateRow label="Input" render={state => <Input placeholder="제목" defaultValue={state === 'default' ? '' : 'Blues in A'} disabled={state === 'disabled'} />} />
              <StateRow label="Input compact" render={state => <Input size="compact" defaultValue="Em7" disabled={state === 'disabled'} />} />
              <StateRow label="NumberField" render={state => <NumberField label="템포" value={tempo} onValueChange={setTempo} min={10} max={400} unit="bpm" disabled={state === 'disabled'} />} />
              <StateRow label="Select" render={state => (
                <Select defaultValue="guitar" disabled={state === 'disabled'}>
                  <SelectTrigger aria-label="악기"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="guitar">기타</SelectItem><SelectItem value="bass">베이스</SelectItem><SelectItem value="drums">드럼</SelectItem>
                  </SelectContent>
                </Select>
              )} />
            </Section>

            <Section title="Slider, Knob, Checkbox, Switch" states>
              <StateRow label="Slider" render={state => <Slider label="볼륨" value={volume} onValueChange={setVolume} max={100} disabled={state === 'disabled'} />} />
              <StateRow label="Knob (pan)" render={state => <Knob label="팬" value={pan} onValueChange={setPan} formatValue={v => (v === 0 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`)} disabled={state === 'disabled'} />} />
              <StateRow label="Checkbox" render={state => <Checkbox defaultChecked={state !== 'default'} aria-label="메트로놈" disabled={state === 'disabled'} />} />
              <StateRow label="Switch" render={state => <Switch defaultChecked={state !== 'default'} aria-label="카운트인" disabled={state === 'disabled'} />} />
            </Section>

            <Section title="Tabs, Tooltip, Popover, menus, Dialog, Toast">
              <Tabs defaultValue="song">
                <TabsList>
                  <TabsTrigger value="song">Song</TabsTrigger><TabsTrigger value="track">Track</TabsTrigger><TabsTrigger value="off" disabled>Disabled</TabsTrigger>
                </TabsList>
                <TabsContent value="song" className="rounded-b-md border border-t-0 border-border bg-panel p-3 text-xs text-muted">Song inspector 내용</TabsContent>
                <TabsContent value="track" className="rounded-b-md border border-t-0 border-border bg-panel p-3 text-xs text-muted">Track inspector 내용</TabsContent>
              </Tabs>
              <div className="flex flex-wrap items-center gap-2">
                <Popover>
                  <PopoverTrigger asChild><Button>속도 팝오버</Button></PopoverTrigger>
                  <PopoverContent>
                    <div className="flex flex-col gap-2 text-xs"><span className="font-medium">재생 속도</span><Slider label="속도" defaultValue={[100]} min={10} max={300} /></div>
                  </PopoverContent>
                </Popover>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild><Button>드롭다운</Button></DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <DropdownMenuItem shortcut="⌘C"><Copy />복사</DropdownMenuItem>
                    <DropdownMenuItem shortcut="⌘X"><Scissors />잘라내기</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuCheckboxItem checked>메트로놈</DropdownMenuCheckboxItem>
                    <DropdownMenuItem destructive>트랙 삭제</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <ContextMenu>
                  <ContextMenuTrigger asChild><div className="flex h-control-default items-center rounded-md border border-dashed border-border px-3 text-xs text-muted">우클릭 영역</div></ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem shortcut="⌘V">붙여넣기</ContextMenuItem><ContextMenuSeparator /><ContextMenuItem destructive>마디 삭제</ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
                <Dialog>
                  <DialogTrigger asChild><Button variant="primary">대화상자</Button></DialogTrigger>
                  <DialogContent>
                    <DialogHeader><DialogTitle>변경 사항 저장</DialogTitle><DialogDescription>닫기 전에 "Blues in A"의 변경 사항을 저장할까요?</DialogDescription></DialogHeader>
                    <DialogFooter><Button variant="ghost">저장 안 함</Button><Button>취소</Button><Button variant="primary">저장</Button></DialogFooter>
                  </DialogContent>
                </Dialog>
                <Button onClick={() => setToastOpen(true)}>토스트</Button>
                <IconButton label="볼륨" variant="default"><Volume2 /></IconButton>
              </div>
              <Toast open={toastOpen} onOpenChange={setToastOpen} tone="success">
                <ToastTitle>저장됨</ToastTitle>
                <ToastDescription>Blues in A.fretline</ToastDescription>
                <ToastAction altText="폴더에서 보기">폴더에서 보기</ToastAction>
              </Toast>
            </Section>
          </div>
        </ScrollArea>
        <ToastViewport />
      </ToastProvider>
    </TooltipProvider>
  );
}
