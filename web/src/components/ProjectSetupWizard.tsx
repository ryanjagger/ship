import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { usePrograms, Program } from '@/contexts/ProgramsContext';

interface ProjectSetupWizardProps {
  open: boolean;
  onCancel: () => void;
  onSubmit: (data: ProjectSetupData) => void;
}

export interface ProjectSetupData {
  title: string;
  program_id: string;
  plan?: string;
  target_date?: string;
}

export function ProjectSetupWizard({
  open,
  onCancel,
  onSubmit,
}: ProjectSetupWizardProps) {
  const { programs, loading } = usePrograms();
  const [title, setTitle] = useState('');
  const [programId, setProgramId] = useState('');
  const [plan, setPlan] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [errors, setErrors] = useState<{ title?: string; program?: string }>({});

  const activePrograms = programs.filter((p: Program) => !p.archived_at);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const newErrors: { title?: string; program?: string } = {};

    if (!title.trim()) {
      newErrors.title = 'Project name is required';
    }

    if (!programId) {
      newErrors.program = 'Please select a program';
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    onSubmit({
      title: title.trim(),
      program_id: programId,
      plan: plan.trim() || undefined,
      target_date: targetDate || undefined,
    });

    // Reset form
    setTitle('');
    setProgramId('');
    setPlan('');
    setTargetDate('');
    setErrors({});
  };

  const handleCancel = () => {
    setTitle('');
    setProgramId('');
    setPlan('');
    setTargetDate('');
    setErrors({});
    onCancel();
  };

  return (
    <Dialog.Root open={open} onOpenChange={(isOpen) => !isOpen && handleCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/60" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[101] w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-background p-6 shadow-xl focus:outline-none"
          onEscapeKeyDown={handleCancel}
        >
          <Dialog.Title className="text-lg font-semibold text-foreground">
            Create New Project
          </Dialog.Title>

          <Dialog.Description className="mt-2 text-sm text-muted">
            Set up your project with key details to get started.
          </Dialog.Description>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            {/* Project Name (required) */}
            <div>
              <label htmlFor="project-name" className="block text-sm font-medium text-foreground">
                Project Name <span className="text-red-500">*</span>
              </label>
              <input
                id="project-name"
                type="text"
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  if (errors.title) setErrors((prev) => ({ ...prev, title: undefined }));
                }}
                placeholder="e.g., Q1 User Onboarding Redesign"
                className={`mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent ${
                  errors.title ? 'border-red-500' : 'border-border'
                }`}
                aria-invalid={errors.title ? true : undefined}
                aria-describedby={errors.title ? 'project-name-error' : undefined}
                autoFocus
              />
              {errors.title && (
                <p id="project-name-error" className="mt-1 text-xs text-red-500">{errors.title}</p>
              )}
            </div>

            {/* Program (required) */}
            <div>
              <label htmlFor="project-program" className="block text-sm font-medium text-foreground">
                Program <span className="text-red-500">*</span>
              </label>
              <select
                id="project-program"
                value={programId}
                onChange={(e) => {
                  setProgramId(e.target.value);
                  if (errors.program) setErrors((prev) => ({ ...prev, program: undefined }));
                }}
                className={`mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent ${
                  errors.program ? 'border-red-500' : 'border-border'
                }`}
                aria-invalid={errors.program ? true : undefined}
                aria-describedby={errors.program ? 'project-program-error' : undefined}
              >
                <option value="">Select a program...</option>
                {loading ? (
                  <option disabled>Loading programs...</option>
                ) : (
                  activePrograms.map((program: Program) => (
                    <option key={program.id} value={program.id}>
                      {program.emoji ? `${program.emoji} ` : ''}{program.name}
                    </option>
                  ))
                )}
              </select>
              {errors.program && (
                <p id="project-program-error" className="mt-1 text-xs text-red-500">{errors.program}</p>
              )}
              {!loading && activePrograms.length === 0 && (
                <p className="mt-1 text-xs text-muted">
                  No programs available. Create a program first.
                </p>
              )}
            </div>

            {/* Plan (optional) */}
            <div>
              <label htmlFor="project-plan" className="block text-sm font-medium text-foreground">
                Plan
                <span className="ml-1 text-xs font-normal text-muted">(optional)</span>
              </label>
              <textarea
                id="project-plan"
                value={plan}
                onChange={(e) => setPlan(e.target.value)}
                placeholder="What are we trying to achieve? e.g., Simplify onboarding to 3 steps to increase conversion by 20%"
                rows={3}
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>

            {/* Target Date (optional) */}
            <div>
              <label htmlFor="project-target-date" className="block text-sm font-medium text-foreground">
                Target Date
                <span className="ml-1 text-xs font-normal text-muted">(optional)</span>
              </label>
              <input
                id="project-target-date"
                type="date"
                value={targetDate}
                onChange={(e) => setTargetDate(e.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>

            {/* Actions */}
            <div className="mt-6 flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={handleCancel}
                className="rounded-md bg-border px-4 py-2 text-sm font-medium text-foreground hover:bg-border/80 focus:outline-none focus:ring-2 focus:ring-border focus:ring-offset-2 focus:ring-offset-background"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading || activePrograms.length === 0}
                className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-background disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Create Project
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
