import { useState, useRef, useEffect, lazy, Suspense } from 'react';
import type { EmojiClickData, Theme } from 'emoji-picker-react';
import { cn } from '@/lib/cn';

const EmojiPicker = lazy(() => import('emoji-picker-react'));

// Inlined Theme.DARK to keep the enum out of the entry chunk.
const EMOJI_PICKER_THEME = 'dark' as Theme;

interface EmojiPickerPopoverProps {
  value?: string | null;
  onChange: (emoji: string | null) => void;
  children: React.ReactNode;
  className?: string;
}

export function EmojiPickerPopover({ value, onChange, children, className }: EmojiPickerPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  // Close on escape
  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen]);

  const handleEmojiClick = (emojiData: EmojiClickData) => {
    onChange(emojiData.emoji);
    setIsOpen(false);
  };

  const handleClear = () => {
    onChange(null);
    setIsOpen(false);
  };

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-background rounded"
      >
        {children}
      </button>

      {isOpen && (
        <div className="absolute z-50 mt-2 left-0">
          <div className="rounded-lg border border-border bg-background shadow-lg overflow-hidden">
            {value && (
              <button
                type="button"
                onClick={handleClear}
                className="w-full px-3 py-2 text-sm text-left text-muted hover:bg-border/50 border-b border-border"
              >
                Remove emoji
              </button>
            )}
            <Suspense
              fallback={
                <div
                  className="flex items-center justify-center text-sm text-muted"
                  style={{ width: 300, height: 350 }}
                >
                  Loading…
                </div>
              }
            >
              <EmojiPicker
                onEmojiClick={handleEmojiClick}
                skinTonesDisabled={true}
                theme={EMOJI_PICKER_THEME}
                height={350}
                width={300}
                searchPlaceholder="Search emoji..."
                previewConfig={{ showPreview: false }}
              />
            </Suspense>
          </div>
        </div>
      )}
    </div>
  );
}
