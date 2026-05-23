import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Command } from 'cmdk';
import { cn } from '@/lib/cn';

export interface Program {
  id: string;
  name: string;
  color: string;
  emoji?: string | null;
}

interface ProgramComboboxProps {
  programs: Program[];
  value: string | null;
  onChange: (value: string | null) => void;
  onNavigate?: (programId: string) => void;
  disabled?: boolean;
  placeholder?: string;
  triggerClassName?: string;
}

export function ProgramCombobox({
  programs,
  value,
  onChange,
  onNavigate,
  disabled = false,
  placeholder = 'Select program...',
  triggerClassName,
}: ProgramComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [isHovered, setIsHovered] = useState(false);

  const selectedProgram = programs.find((p) => p.id === value);

  const handleProgramClick = (e: React.MouseEvent) => {
    if (selectedProgram && onNavigate) {
      e.stopPropagation();
      onNavigate(selectedProgram.id);
    }
  };

  const handleCaretClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!disabled) {
      setOpen(true);
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={disabled ? undefined : setOpen}>
      <div
        className={cn(
          'group flex items-center rounded transition-colors overflow-hidden',
          'hover:bg-border/30',
          disabled && 'pointer-events-none opacity-50',
          triggerClassName
        )}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {selectedProgram ? (
          <>
            {/* Clickable program area - navigates */}
            <button
              type="button"
              onClick={handleProgramClick}
              className={cn(
                'flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1 text-sm overflow-hidden',
                'focus:outline-none',
                onNavigate && 'cursor-pointer hover:underline'
              )}
            >
              <span
                className="shrink-0 rounded px-1.5 py-0.5 text-xs font-bold text-white whitespace-nowrap"
                style={{ backgroundColor: selectedProgram.color }}
              >
                {selectedProgram.emoji || selectedProgram.name[0]}
              </span>
              <span className="truncate text-foreground">{selectedProgram.name}</span>
            </button>

            {/* Dropdown caret - opens reassignment */}
            <Popover.Trigger asChild>
              <button
                type="button"
                onClick={handleCaretClick}
                className={cn(
                  'flex h-full shrink-0 items-center px-2 transition-opacity',
                  'hover:bg-border/50 rounded-r focus:outline-none',
                  isHovered ? 'opacity-100' : 'opacity-0'
                )}
                aria-label="Change program assignment"
              >
                <ChevronIcon className="h-3 w-3 text-muted" />
              </button>
            </Popover.Trigger>
          </>
        ) : (
          /* Empty state - entire area is clickable to assign */
          <Popover.Trigger asChild>
            <button
              type="button"
              className="flex h-full w-full items-center justify-center text-sm focus:outline-none"
            >
              <span className="text-muted">{placeholder}</span>
            </button>
          </Popover.Trigger>
        )}
      </div>

      <Popover.Portal>
        <Popover.Content
          className="z-50 w-[220px] rounded-md border border-border bg-background shadow-lg"
          sideOffset={4}
          align="start"
        >
          <Command
            className="flex flex-col"
            filter={(value, search) => {
              const program = programs.find((p) => p.id === value);
              if (!program) return 0;
              const name = (program.name || '').toLowerCase();
              const s = (search || '').toLowerCase();
              if (name.includes(s)) return 1;
              return 0;
            }}
          >
            <div className="border-b border-border p-2">
              <Command.Input
                value={search}
                onValueChange={setSearch}
                placeholder="Search programs..."
                className="w-full bg-transparent text-sm text-foreground placeholder:text-muted focus:outline-none"
              />
            </div>

            <Command.List className="max-h-[200px] overflow-auto p-1">
              <Command.Empty className="px-2 py-4 text-center text-sm text-muted">
                No programs found
              </Command.Empty>

              {/* Clear option */}
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
                None
              </Command.Item>

              {programs.map((program) => (
                <Command.Item
                  key={program.id}
                  value={program.id}
                  onSelect={() => {
                    onChange(program.id);
                    setOpen(false);
                    setSearch('');
                  }}
                  className={cn(
                    'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm',
                    'data-[selected=true]:bg-border/50',
                    value === program.id && 'text-accent-text'
                  )}
                >
                  <span
                    className="rounded px-1.5 py-0.5 text-xs font-bold text-white whitespace-nowrap"
                    style={{ backgroundColor: program.color }}
                  >
                    {program.emoji || program.name[0]}
                  </span>
                  <span className="truncate">{program.name}</span>
                  {value === program.id && (
                    <CheckIcon className="ml-auto h-4 w-4 text-accent-text" />
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
