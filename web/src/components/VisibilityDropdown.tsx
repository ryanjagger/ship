import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { cn } from '@/lib/cn';

interface VisibilityDropdownProps {
  value: 'private' | 'workspace';
  onChange: (value: 'private' | 'workspace') => void;
  disabled?: boolean;
}

const options = [
  { value: 'private' as const, label: 'Private', icon: LockIcon },
  { value: 'workspace' as const, label: 'Workspace', icon: GlobeIcon },
];

export function VisibilityDropdown({ value, onChange, disabled = false }: VisibilityDropdownProps) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value) || options[1];
  const SelectedIcon = selected.icon;

  return (
    <Popover.Root open={open} onOpenChange={disabled ? undefined : setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'flex w-full items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-left text-sm',
            'hover:bg-border/30 transition-colors',
            'focus:outline-none focus:ring-1 focus:ring-accent',
            disabled && 'opacity-50 cursor-not-allowed'
          )}
          title={disabled ? 'Only the document creator can change visibility' : undefined}
        >
          <SelectedIcon className="h-4 w-4 shrink-0 text-muted" />
          <span className="truncate text-foreground">{selected.label}</span>
          <ChevronIcon className="ml-auto h-3 w-3 shrink-0 text-muted" />
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          className="z-50 w-[180px] rounded-md border border-border bg-background shadow-lg"
          sideOffset={4}
          align="start"
        >
          <div className="p-1">
            {options.map((option) => {
              const Icon = option.icon;
              const isSelected = value === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm',
                    'hover:bg-border/50 transition-colors',
                    isSelected && 'text-accent-text'
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="flex-1">{option.label}</span>
                  {isSelected && <CheckIcon className="h-4 w-4 shrink-0 text-accent-text" />}
                </button>
              );
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function LockIcon({ className }: { className?: string }) {
  return (
    <svg className={className || 'h-4 w-4'} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
      />
    </svg>
  );
}

function GlobeIcon({ className }: { className?: string }) {
  return (
    <svg className={className || 'h-4 w-4'} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"
      />
    </svg>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  );
}
