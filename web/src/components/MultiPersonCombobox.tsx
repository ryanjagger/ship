import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Command } from 'cmdk';
import { cn } from '@/lib/cn';
import type { Person } from './PersonCombobox';

interface MultiPersonComboboxProps {
  people: Person[];
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .map(part => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

export function MultiPersonCombobox({
  people,
  value,
  onChange,
  disabled = false,
  placeholder = 'Select people...',
  className,
}: MultiPersonComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const selectedPeople = people.filter((p) => value.includes(p.user_id));

  const togglePerson = (userId: string) => {
    if (value.includes(userId)) {
      onChange(value.filter((id) => id !== userId));
    } else {
      onChange([...value, userId]);
    }
  };

  const removePerson = (userId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(value.filter((id) => id !== userId));
  };

  return (
    <Popover.Root open={open} onOpenChange={disabled ? undefined : setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'flex w-full min-h-[34px] flex-wrap items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-left text-sm',
            'hover:bg-border/30 transition-colors',
            'focus:outline-none focus:ring-1 focus:ring-accent',
            disabled && 'opacity-50 cursor-not-allowed',
            className
          )}
        >
          {selectedPeople.length > 0 ? (
            <>
              {selectedPeople.map((person) => (
                <span
                  key={person.user_id}
                  className="inline-flex items-center gap-1 rounded bg-accent/20 px-1.5 py-0.5 text-xs text-foreground"
                >
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent text-[8px] font-medium text-white">
                    {getInitials(person.name)}
                  </span>
                  <span className="truncate max-w-[80px]">{person.name}</span>
                  <button
                    type="button"
                    onClick={(e) => removePerson(person.user_id, e)}
                    className="ml-0.5 hover:text-red-400"
                  >
                    <XIcon className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </>
          ) : (
            <span className="text-muted">{placeholder}</span>
          )}
          <ChevronIcon className="ml-auto h-3 w-3 shrink-0 text-muted" />
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          className="z-50 w-[220px] rounded-md border border-border bg-background shadow-lg"
          sideOffset={4}
          align="start"
        >
          <Command
            className="flex flex-col"
            filter={(cmdValue, cmdSearch) => {
              const person = people.find((p) => p.user_id === cmdValue);
              if (!person) return 0;
              const name = person.name.toLowerCase();
              const email = person.email.toLowerCase();
              const s = cmdSearch.toLowerCase();
              if (name.includes(s) || email.includes(s)) return 1;
              return 0;
            }}
          >
            <div className="border-b border-border p-2">
              <Command.Input
                value={search}
                onValueChange={setSearch}
                placeholder="Search people..."
                className="w-full bg-transparent text-sm text-foreground placeholder:text-muted focus:outline-none"
              />
            </div>

            <Command.List className="max-h-[200px] overflow-auto p-1">
              <Command.Empty className="px-2 py-4 text-center text-sm text-muted">
                No people found
              </Command.Empty>

              {/* Clear all option - only show if there are selections */}
              {value.length > 0 && (
                <Command.Item
                  value="__clear_all__"
                  onSelect={() => {
                    onChange([]);
                    setSearch('');
                  }}
                  className={cn(
                    'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm',
                    'data-[selected=true]:bg-border/50',
                    'text-muted'
                  )}
                >
                  <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-border text-[10px] font-medium text-muted">
                    &mdash;
                  </div>
                  <span>Clear all</span>
                </Command.Item>
              )}

              {people.map((person) => {
                const isSelected = value.includes(person.user_id);
                return (
                  <Command.Item
                    key={person.user_id}
                    value={person.user_id}
                    onSelect={() => {
                      togglePerson(person.user_id);
                      setSearch('');
                    }}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm',
                      'data-[selected=true]:bg-border/50',
                      isSelected && 'text-accent-text'
                    )}
                  >
                    <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent text-[10px] font-medium text-white">
                      {getInitials(person.name)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate">{person.name}</div>
                      <div className="truncate text-xs text-muted">{person.email}</div>
                    </div>
                    {isSelected && (
                      <CheckIcon className="ml-auto h-4 w-4 shrink-0 text-accent-text" />
                    )}
                  </Command.Item>
                );
              })}
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

function XIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}
