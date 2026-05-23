import { useState, useId } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Command } from 'cmdk';
import { cn } from '@/lib/cn';

export interface ComboboxOption {
  value: string;
  label: string;
  description?: string;
}

interface ComboboxProps {
  options: ComboboxOption[];
  value: string | null;
  onChange: (value: string | null) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  allowClear?: boolean;
  clearLabel?: string;
  'aria-label'?: string;
  id?: string;
}

export function Combobox({
  options,
  value,
  onChange,
  placeholder = 'Select...',
  searchPlaceholder = 'Search...',
  emptyText = 'No results found',
  allowClear = true,
  clearLabel = 'None',
  'aria-label': ariaLabel,
  id: providedId,
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const generatedId = useId();
  const listboxId = providedId ? `${providedId}-listbox` : `combobox-listbox${generatedId.replace(/:/g, '-')}`;

  const selectedOption = options.find((opt) => opt.value === value);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-haspopup="listbox"
          aria-label={ariaLabel}
          className={cn(
            'flex w-full items-center justify-between rounded border border-border bg-background px-2 py-1.5 text-left text-sm transition-colors',
            'hover:bg-border/30 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent',
            !selectedOption && 'text-muted'
          )}
        >
          <span className="truncate">
            {selectedOption?.label || placeholder}
          </span>
          <ChevronIcon className="ml-2 h-4 w-4 shrink-0 text-muted" />
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          className="z-50 w-[var(--radix-popover-trigger-width)] rounded-md border border-border bg-background shadow-lg"
          sideOffset={4}
          align="start"
        >
          <Command
            className="flex flex-col"
            filter={(value, search) => {
              const option = options.find((o) => o.value === value);
              if (!option) return 0;
              const label = option.label.toLowerCase();
              const desc = option.description?.toLowerCase() || '';
              const s = search.toLowerCase();
              if (label.includes(s) || desc.includes(s)) return 1;
              return 0;
            }}
          >
            <div className="border-b border-border p-2">
              <Command.Input
                value={search}
                onValueChange={setSearch}
                placeholder={searchPlaceholder}
                className="w-full bg-transparent text-sm text-foreground placeholder:text-muted focus:outline-none"
              />
            </div>

            <Command.List id={listboxId} role="listbox" className="max-h-[200px] overflow-auto p-1">
              <Command.Empty className="px-2 py-4 text-center text-sm text-muted">
                {emptyText}
              </Command.Empty>

              {allowClear && (
                <Command.Item
                  value="__clear__"
                  onSelect={() => {
                    onChange(null);
                    setOpen(false);
                    setSearch('');
                  }}
                  className={cn(
                    'flex cursor-pointer items-center rounded px-2 py-1.5 text-sm text-muted',
                    'data-[selected=true]:bg-border/50 data-[selected=true]:text-foreground'
                  )}
                >
                  {clearLabel}
                </Command.Item>
              )}

              {options.map((option) => (
                <Command.Item
                  key={option.value}
                  value={option.value}
                  onSelect={() => {
                    onChange(option.value);
                    setOpen(false);
                    setSearch('');
                  }}
                  className={cn(
                    'flex cursor-pointer items-center justify-between rounded px-2 py-1.5 text-sm',
                    'data-[selected=true]:bg-border/50',
                    value === option.value && 'text-accent-text'
                  )}
                >
                  <div className="flex flex-col">
                    <span>{option.label}</span>
                    {option.description && (
                      <span className="text-xs text-muted">{option.description}</span>
                    )}
                  </div>
                  {value === option.value && (
                    <CheckIcon className="h-4 w-4 text-accent-text" />
                  )}
                </Command.Item>
              ))}
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
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
