import { useId } from 'react';
import type { ReactNode } from 'react';

export function Field({ label, children }: { readonly label: string; readonly children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <label htmlFor={id} className="grid grid-cols-[5.5rem_1fr] items-center gap-2 text-xs text-muted">
      <span className="truncate">{label}</span>
      {children(id)}
    </label>
  );
}
