// RG-013 [INVIOLÁVEL] — "é PROIBIDO comunicar estado apenas por cor".
// Badge de estado (sistema de design §6): ícone + texto SEMPRE juntos, nunca
// só um ponto colorido. `tone` mapeia 1:1 para os 5 estados semânticos do
// design system — done/pending/warning/blocked/neutral significam sempre a
// mesma coisa em todo o sistema (§2).
import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../utils/cn';

export type StatusTone = 'done' | 'pending' | 'warning' | 'blocked' | 'neutral';

const TONE_CLASSES: Record<StatusTone, string> = {
  done: 'text-state-done bg-state-done-bg',
  pending: 'text-state-pending bg-state-pending-bg',
  warning: 'text-state-warning bg-state-warning-bg',
  blocked: 'text-state-blocked bg-state-blocked-bg',
  neutral: 'text-state-neutral bg-state-neutral-bg',
};

export interface StatusBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone: StatusTone;
  icon: LucideIcon;
  label: string;
}

const StatusBadge = React.forwardRef<HTMLSpanElement, StatusBadgeProps>(
  ({ tone, icon: Icon, label, className, ...props }, ref) => (
    <span
      ref={ref}
      className={cn('inline-flex h-[22px] items-center gap-1.5 rounded-field px-2 text-label', TONE_CLASSES[tone], className)}
      {...props}
    >
      <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      <span>{label}</span>
    </span>
  )
);

StatusBadge.displayName = 'StatusBadge';

export { StatusBadge };
