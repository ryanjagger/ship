import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Command } from 'cmdk';
import { cn } from '@/lib/cn';

export interface Project {
  id: string;
  title: string;
  color?: string | null;
  programId: string | null;
  programName: string | null;
  programEmoji?: string | null;
  programColor?: string | null;
}

interface ProjectComboboxProps {
  projects: Project[];
  value: string | null;
  onChange: (value: string | null) => void;
  onNavigate?: (projectId: string) => void;
  disabled?: boolean;
  placeholder?: string;
  triggerClassName?: string;
  /** If provided and exists in projects list, shows a "Same as last week" quick option */
  previousWeekProject?: Project | null;
}

export function ProjectCombobox({
  projects,
  value,
  onChange,
  onNavigate,
  disabled = false,
  placeholder = 'Select project...',
  triggerClassName,
  previousWeekProject,
}: ProjectComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [isHovered, setIsHovered] = useState(false);

  const selectedProject = projects.find((p) => p.id === value);

  // Check if previous week's project is valid (exists in available projects)
  const validPreviousWeekProject = previousWeekProject
    ? projects.find((p) => p.id === previousWeekProject.id)
    : null;

  // Group projects by program
  const projectsByProgram = projects.reduce<Record<string, Project[]>>((acc, project) => {
    const key = project.programId || '__unassigned__';
    if (!acc[key]) acc[key] = [];
    acc[key].push(project);
    return acc;
  }, {});

  // Sort programs alphabetically, with Unassigned last
  const sortedProgramKeys = Object.keys(projectsByProgram).sort((a, b) => {
    if (a === '__unassigned__') return 1;
    if (b === '__unassigned__') return -1;
    const nameA = projectsByProgram[a][0]?.programName || '';
    const nameB = projectsByProgram[b][0]?.programName || '';
    return nameA.localeCompare(nameB);
  });

  const handleProjectClick = (e: React.MouseEvent) => {
    if (selectedProject && onNavigate) {
      e.stopPropagation();
      onNavigate(selectedProject.id);
    }
  };

  const handleCaretClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!disabled) {
      setOpen(true);
    }
  };

  // Get the color to display - prefer project's own color, fallback to program's color
  const badgeColor = selectedProject?.color || selectedProject?.programColor || '#6b7280';

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
        {selectedProject ? (
          <>
            {/* Clickable project area - navigates */}
            <button
              type="button"
              onClick={handleProjectClick}
              className={cn(
                'flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1 text-sm overflow-hidden',
                'focus:outline-none',
                onNavigate && 'cursor-pointer hover:underline'
              )}
              title={selectedProject.title}
            >
              <span
                className="shrink-0 rounded px-1.5 py-0.5 text-xs font-bold text-white whitespace-nowrap"
                style={{ backgroundColor: badgeColor }}
              >
                {selectedProject.programEmoji || selectedProject.title[0]}
              </span>
              <span className="truncate text-foreground">{selectedProject.title}</span>
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
                aria-label="Change project assignment"
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
          className="z-50 w-[260px] rounded-md border border-border bg-background shadow-lg"
          sideOffset={4}
          align="start"
        >
          <Command
            className="flex flex-col"
            filter={(value, search) => {
              const project = projects.find((p) => p.id === value);
              if (!project) return 0;
              const title = (project.title || '').toLowerCase();
              const programName = (project.programName || '').toLowerCase();
              const s = (search || '').toLowerCase();
              if (title.includes(s) || programName.includes(s)) return 1;
              return 0;
            }}
          >
            {/* Quick select: Same as last week */}
            {validPreviousWeekProject && (
              <button
                type="button"
                onClick={() => {
                  onChange(validPreviousWeekProject.id);
                  setOpen(false);
                  setSearch('');
                }}
                className={cn(
                  'flex items-center gap-2 px-2 py-2 text-sm text-left',
                  'bg-accent/10 hover:bg-accent/20 border-b border-border',
                  'transition-colors'
                )}
              >
                <span
                  className="shrink-0 rounded px-1.5 py-0.5 text-xs font-bold text-white"
                  style={{ backgroundColor: validPreviousWeekProject.programColor || '#6b7280' }}
                >
                  {validPreviousWeekProject.programEmoji || validPreviousWeekProject.title[0]}
                </span>
                <span className="truncate">
                  <span className="text-muted">Same as last week:</span>{' '}
                  <span className="text-foreground">{validPreviousWeekProject.title}</span>
                </span>
              </button>
            )}

            <div className="border-b border-border p-2">
              <Command.Input
                value={search}
                onValueChange={setSearch}
                placeholder="Search projects..."
                className="w-full bg-transparent text-sm text-foreground placeholder:text-muted focus:outline-none"
              />
            </div>

            <Command.List className="max-h-[300px] overflow-auto p-1">
              <Command.Empty className="px-2 py-4 text-center text-sm text-muted">
                No projects found
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

              {/* Projects grouped by program */}
              {sortedProgramKeys.map((programKey) => {
                const programProjects = projectsByProgram[programKey];
                const firstProject = programProjects[0];
                const programName = programKey === '__unassigned__'
                  ? 'Not assigned to a program'
                  : firstProject?.programName || 'Unknown';
                const programColor = firstProject?.programColor || '#6b7280';
                const programEmoji = firstProject?.programEmoji;

                return (
                  <Command.Group key={programKey} heading="">
                    {/* Program header */}
                    <div className="flex items-center gap-2 px-2 py-1.5 text-xs font-semibold text-muted border-t border-border/50 mt-1 first:mt-0 first:border-t-0">
                      <span
                        className="shrink-0 rounded px-1 py-0.5 text-[10px] font-bold text-white"
                        style={{ backgroundColor: programColor }}
                      >
                        {programEmoji || programName[0]}
                      </span>
                      <span className="truncate">{programName}</span>
                    </div>

                    {/* Projects under this program */}
                    {programProjects.map((project) => (
                      <Command.Item
                        key={project.id}
                        value={project.id}
                        onSelect={() => {
                          onChange(project.id);
                          setOpen(false);
                          setSearch('');
                        }}
                        className={cn(
                          'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 pl-4 text-sm',
                          'data-[selected=true]:bg-border/50',
                          value === project.id && 'text-accent-text'
                        )}
                      >
                        <span className="truncate">{project.title}</span>
                        {value === project.id && (
                          <CheckIcon className="ml-auto h-4 w-4 shrink-0 text-accent-text" />
                        )}
                      </Command.Item>
                    ))}
                  </Command.Group>
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
