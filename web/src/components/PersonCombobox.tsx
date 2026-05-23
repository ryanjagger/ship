import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Command } from 'cmdk';
import { cn } from '@/lib/cn';

export interface Person {
  id: string;       // Document ID (for navigation)
  user_id: string;  // User ID (for assignee/owner selection)
  name: string;
  email: string;
}

interface PersonComboboxProps {
  people: Person[];
  value: string | null;
  onChange: (value: string | null) => void;
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

export function PersonCombobox({
  people,
  value,
  onChange,
  disabled = false,
  placeholder = 'Select person...',
  className,
}: PersonComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  // Only search for a match if value is truthy - prevents matching pending users (who have null user_id)
  const selectedPerson = value ? people.find((p) => p.user_id === value) : null;

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
            disabled && 'opacity-50 cursor-not-allowed',
            className
          )}
        >
          {selectedPerson ? (
            <>
              <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent text-[10px] font-medium text-white">
                {getInitials(selectedPerson.name)}
              </div>
              <span className="truncate text-foreground">{selectedPerson.name}</span>
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
            filter={(value, search) => {
              const person = people.find((p) => p.user_id === value);
              if (!person) return 0;
              const name = person.name.toLowerCase();
              const email = person.email.toLowerCase();
              const s = search.toLowerCase();
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

              {/* Unassigned option - only show if there's a current value */}
              {value && (
                <Command.Item
                  value="__unassigned__"
                  onSelect={() => {
                    onChange(null);
                    setOpen(false);
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
                  <span>Unassigned</span>
                </Command.Item>
              )}

              {people.map((person) => (
                <Command.Item
                  key={person.user_id}
                  value={person.user_id}
                  onSelect={() => {
                    onChange(person.user_id);
                    setOpen(false);
                    setSearch('');
                  }}
                  className={cn(
                    'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm',
                    'data-[selected=true]:bg-border/50',
                    value === person.user_id && 'text-accent-text'
                  )}
                >
                  <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent text-[10px] font-medium text-white">
                    {getInitials(person.name)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{person.name}</div>
                    <div className="truncate text-xs text-muted">{person.email}</div>
                  </div>
                  {value === person.user_id && (
                    <CheckIcon className="ml-auto h-4 w-4 shrink-0 text-accent-text" />
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
