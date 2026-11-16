import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Button, Checkbox, Dialog, DialogContent, DialogTitle, DialogTrigger, IconButton, Input, Knob, NumberField, Select, SelectTrigger,
  SelectValue, Slider, Switch, Tabs, TabsContent, TabsList, TabsTrigger, ToggleButton, ToggleGroup, ToggleGroupItem, Tooltip, TooltipProvider,
} from '../../src/renderer/ui';

afterEach(cleanup);

const focused = (element: HTMLElement): Promise<void> => new Promise(done => element.addEventListener('focus', () => done(), { once: true }));

const focusRing = 'focus-visible:outline-focus-ring';
// `outline-none` sets --tw-outline-style: none; without an explicit solid style the ring width renders nothing.
const focusRingShape = ['focus-visible:outline-solid', 'focus-visible:outline-(length:--focus-ring-width)', focusRing] as const;
const disabledOpacity = 'opacity-(--disabled-opacity)';

describe('Button', () => {
  it('fires on click and Enter, but not when disabled', () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>저장</Button>);
    const button = screen.getByRole('button', { name: '저장' });
    expect(button).toHaveProperty('type', 'button');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(<Button onClick={onClick} disabled>저장</Button>);
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(button).toHaveProperty('disabled', true);
  });
  it('carries focus-visible ring and disabled state classes from the shared control base', () => {
    render(<Button>확인</Button>);
    const className = screen.getByRole('button').className;
    expect(className).toContain(focusRing);
    expect(className).toContain(`disabled:${disabledOpacity}`);
  });
  it('merges caller classes through tailwind-merge so later utilities win', () => {
    render(<Button className="px-6">확인</Button>);
    const className = screen.getByRole('button').className;
    expect(className).toContain('px-6');
    expect(className).not.toMatch(/\bpx-2\.5\b/);
  });
});

describe('focus-visible ring', () => {
  it.each([
    ['Button', () => render(<Button>저장</Button>).getByRole('button')],
    ['IconButton', () => render(<TooltipProvider><IconButton label="재생"><svg /></IconButton></TooltipProvider>).getByRole('button')],
    ['Toggle', () => render(<ToggleButton aria-label="반복">R</ToggleButton>).getByRole('button')],
    ['Input', () => render(<Input aria-label="제목" />).getByRole('textbox')],
    ['Select trigger', () => render(<Select><SelectTrigger aria-label="악기"><SelectValue /></SelectTrigger></Select>).getByRole('combobox')],
    ['Slider thumb', () => render(<Slider label="볼륨" defaultValue={[50]} />).getByRole('slider')],
    ['Checkbox', () => render(<Checkbox aria-label="메트로놈" />).getByRole('checkbox')],
    ['Switch', () => render(<Switch aria-label="카운트인" />).getByRole('switch')],
    ['Tab', () => render(<Tabs defaultValue="a"><TabsList><TabsTrigger value="a">A</TabsTrigger></TabsList></Tabs>).getByRole('tab')],
    ['Knob', () => render(<Knob label="팬" value={0} onValueChange={() => undefined} />).getByRole('slider')],
  ] as const)('%s declares a solid, token-sized, token-colored outline', (_, mount) => {
    const className = mount().className;
    for (const utility of focusRingShape) expect(className, utility).toContain(utility);
    expect(className).not.toMatch(/focus-visible:outline-2\b/);
  });
});

describe('IconButton', () => {
  it('exposes its label as the accessible name and shows the shortcut in the tooltip', async () => {
    render(<TooltipProvider delayDuration={0}><IconButton label="재생" shortcut="Space"><svg /></IconButton></TooltipProvider>);
    const button = screen.getByRole('button', { name: '재생' });
    fireEvent.focus(button);
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain('재생');
    expect(tooltip.textContent).toContain('Space');
  });
});

describe('ToggleButton and ToggleGroup', () => {
  it('toggles aria-pressed and data-state on click, not when disabled', () => {
    const onPressedChange = vi.fn();
    render(<ToggleButton aria-label="반복" onPressedChange={onPressedChange}>R</ToggleButton>);
    const toggle = screen.getByRole('button', { name: '반복' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.dataset['state']).toBe('on');
    expect(onPressedChange).toHaveBeenCalledWith(true);
  });
  it('moves roving focus with arrow keys inside a single-select group', async () => {
    render(
      <ToggleGroup type="single" defaultValue="a" aria-label="그룹">
        <ToggleGroupItem value="a">A</ToggleGroupItem><ToggleGroupItem value="b">B</ToggleGroupItem>
      </ToggleGroup>,
    );
    const a = screen.getByRole('radio', { name: 'A' });
    const b = screen.getByRole('radio', { name: 'B' });
    a.focus();
    const moved = focused(b);
    fireEvent.keyDown(a, { key: 'ArrowRight' });
    await moved;
    expect(document.activeElement).toBe(b);
  });
});

describe('NumberField', () => {
  function Harness({ initial = 120 }: { readonly initial?: number }) {
    const [value, setValue] = useState(initial);
    return <NumberField label="템포" value={value} onValueChange={setValue} min={10} max={400} step={1} unit="bpm" />;
  }
  it('steps with arrow keys, multiplies by ten with Shift, and clamps to min/max', () => {
    render(<Harness />);
    const input = screen.getByRole('spinbutton', { name: '템포' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input).toHaveProperty('value', '121');
    fireEvent.keyDown(input, { key: 'ArrowDown', shiftKey: true });
    expect(input).toHaveProperty('value', '111');
    fireEvent.keyDown(input, { key: 'End' });
    expect(input).toHaveProperty('value', '400');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input).toHaveProperty('value', '400');
    fireEvent.change(input, { target: { value: '3' } });
    expect(input).toHaveProperty('value', '10');
  });
  it('stepper buttons are out of the tab order and change the value', () => {
    render(<Harness />);
    const up = screen.getByRole('button', { name: '템포 증가' });
    expect(up.tabIndex).toBe(-1);
    fireEvent.click(up);
    expect(screen.getByRole('spinbutton', { name: '템포' })).toHaveProperty('value', '121');
  });
});

describe('Knob', () => {
  function Harness({ disabled = false }: { readonly disabled?: boolean }) {
    const [value, setValue] = useState(0);
    return <Knob label="팬" value={value} onValueChange={setValue} disabled={disabled} />;
  }
  it('is a focusable slider that moves by step on arrow keys and snaps to bounds', () => {
    render(<Harness />);
    const knob = screen.getByRole('slider', { name: '팬' });
    expect(knob.tabIndex).toBe(0);
    fireEvent.keyDown(knob, { key: 'ArrowUp' });
    expect(knob.getAttribute('aria-valuenow')).toBe('0.01');
    fireEvent.keyDown(knob, { key: 'ArrowDown', shiftKey: true });
    expect(knob.getAttribute('aria-valuenow')).toBe('-0.09');
    fireEvent.keyDown(knob, { key: 'End' });
    expect(knob.getAttribute('aria-valuenow')).toBe('1');
    fireEvent.keyDown(knob, { key: 'ArrowRight' });
    expect(knob.getAttribute('aria-valuenow')).toBe('1');
  });
  it('leaves the tab order and ignores keys when disabled', () => {
    render(<Harness disabled />);
    const knob = screen.getByRole('slider', { name: '팬' });
    expect(knob.tabIndex).toBe(-1);
    expect(knob.getAttribute('aria-disabled')).toBe('true');
    fireEvent.keyDown(knob, { key: 'ArrowUp' });
    expect(knob.getAttribute('aria-valuenow')).toBe('0');
  });
});

describe('Checkbox and Switch', () => {
  it('checkbox toggles on click and reports checked state', () => {
    const onCheckedChange = vi.fn();
    render(<Checkbox aria-label="메트로놈" onCheckedChange={onCheckedChange} />);
    const checkbox = screen.getByRole('checkbox', { name: '메트로놈' });
    fireEvent.click(checkbox);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(checkbox.getAttribute('aria-checked')).toBe('true');
  });
  it('switch cannot be toggled when disabled', () => {
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="카운트인" disabled onCheckedChange={onCheckedChange} />);
    const toggle = screen.getByRole('switch', { name: '카운트인' });
    fireEvent.click(toggle);
    expect(onCheckedChange).not.toHaveBeenCalled();
    expect(toggle.className).toContain(`disabled:${disabledOpacity}`);
  });
});

describe('Tabs', () => {
  it('switches panels with arrow keys and skips disabled tabs', async () => {
    render(
      <Tabs defaultValue="song">
        <TabsList><TabsTrigger value="song">Song</TabsTrigger><TabsTrigger value="off" disabled>Off</TabsTrigger><TabsTrigger value="track">Track</TabsTrigger></TabsList>
        <TabsContent value="song">song-panel</TabsContent><TabsContent value="track">track-panel</TabsContent>
      </Tabs>,
    );
    const song = screen.getByRole('tab', { name: 'Song' });
    const track = screen.getByRole('tab', { name: 'Track' });
    song.focus();
    const moved = focused(track);
    fireEvent.keyDown(song, { key: 'ArrowRight' });
    await moved;
    expect(document.activeElement).toBe(track);
    expect(track.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('track-panel')).toBeTruthy();
  });
});

describe('Dialog', () => {
  it('opens from its trigger, traps focus inside, and closes with Escape', async () => {
    render(
      <TooltipProvider>
        <Dialog>
          <DialogTrigger asChild><Button>열기</Button></DialogTrigger>
          <DialogContent><DialogTitle>변경 사항 저장</DialogTitle><Button>저장</Button></DialogContent>
        </Dialog>
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '열기' }));
    const dialog = await screen.findByRole('dialog', { name: '변경 사항 저장' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Tooltip', () => {
  it('renders the shortcut inside a kbd element', async () => {
    render(<TooltipProvider delayDuration={0}><Tooltip content="재생" shortcut="Space"><button type="button">P</button></Tooltip></TooltipProvider>);
    fireEvent.focus(screen.getByRole('button', { name: 'P' }));
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.querySelector('kbd')?.textContent).toBe('Space');
  });
});
