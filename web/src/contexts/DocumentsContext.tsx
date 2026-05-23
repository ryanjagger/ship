/**
 * @deprecated Use useUnifiedDocuments from '@/hooks/useUnifiedDocuments' instead.
 *
 * This context is maintained for backward compatibility but should not be used
 * for new code. The unified document model treats all document types consistently
 * through a single hook.
 *
 * Migration:
 *   Before: const { documents } = useDocuments()
 *   After:  const { byType: { wiki: documents } } = useUnifiedDocuments({ type: 'wiki' })
 */
import { createContext, useContext, ReactNode } from 'react';
import { useDocuments as useDocumentsQuery, WikiDocument } from '@/hooks/useDocumentsQuery';

export type { WikiDocument };

interface DocumentsContextValue {
  documents: WikiDocument[];
  loading: boolean;
  isError: boolean;
  error: Error | null;
  createDocument: (parentId?: string) => Promise<WikiDocument | null>;
  updateDocument: (id: string, updates: Partial<WikiDocument>) => Promise<WikiDocument | null>;
  deleteDocument: (id: string) => Promise<boolean>;
  refreshDocuments: () => Promise<void>;
}

const DocumentsContext = createContext<DocumentsContextValue | null>(null);

export function DocumentsProvider({ children }: { children: ReactNode }) {
  const documentsData = useDocumentsQuery();

  return (
    <DocumentsContext.Provider value={documentsData}>
      {children}
    </DocumentsContext.Provider>
  );
}

export function useDocuments() {
  const context = useContext(DocumentsContext);
  if (!context) {
    throw new Error('useDocuments must be used within DocumentsProvider');
  }
  return context;
}
