import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { queryClient, queryPersister } from '@/lib/queryClient';
import { WorkspaceProvider } from '@/contexts/WorkspaceContext';
import { AuthProvider, useAuth } from '@/hooks/useAuth';
import { RealtimeEventsProvider } from '@/hooks/useRealtimeEvents';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { DocumentsProvider } from '@/contexts/DocumentsContext';
import { ProgramsProvider } from '@/contexts/ProgramsContext';
import { IssuesProvider } from '@/contexts/IssuesContext';
import { ProjectsProvider } from '@/contexts/ProjectsContext';
import { ArchivedPersonsProvider } from '@/contexts/ArchivedPersonsContext';
import { CurrentDocumentProvider } from '@/contexts/CurrentDocumentContext';
import { FleetChatProvider } from '@/contexts/FleetChatContext';
import { UploadProvider } from '@/contexts/UploadContext';
import { LoginPage } from '@/pages/Login';
import { AppLayout } from '@/pages/App';
import { PublicFeedbackPage } from '@/pages/PublicFeedback';
import { InviteAcceptPage } from '@/pages/InviteAccept';
import { SetupPage } from '@/pages/Setup';
import { ReviewQueueProvider } from '@/contexts/ReviewQueueContext';
import { ToastProvider } from '@/components/ui/Toast';
import { MutationErrorToast } from '@/components/MutationErrorToast';
import './index.css';

const DocumentsPage = React.lazy(() => import('@/pages/Documents').then(m => ({ default: m.DocumentsPage })));
const IssuesPage = React.lazy(() => import('@/pages/Issues').then(m => ({ default: m.IssuesPage })));
const ProgramsPage = React.lazy(() => import('@/pages/Programs').then(m => ({ default: m.ProgramsPage })));
const TeamModePage = React.lazy(() => import('@/pages/TeamMode').then(m => ({ default: m.TeamModePage })));
const TeamDirectoryPage = React.lazy(() => import('@/pages/TeamDirectory').then(m => ({ default: m.TeamDirectoryPage })));
const PersonEditorPage = React.lazy(() => import('@/pages/PersonEditor').then(m => ({ default: m.PersonEditorPage })));
const FeedbackEditorPage = React.lazy(() => import('@/pages/FeedbackEditor').then(m => ({ default: m.FeedbackEditorPage })));
const ProjectsPage = React.lazy(() => import('@/pages/Projects').then(m => ({ default: m.ProjectsPage })));
const InsightsPage = React.lazy(() => import('@/pages/Insights').then(m => ({ default: m.InsightsPage })));
const DashboardPage = React.lazy(() => import('@/pages/Dashboard').then(m => ({ default: m.DashboardPage })));
const MyWeekPage = React.lazy(() => import('@/pages/MyWeekPage').then(m => ({ default: m.MyWeekPage })));
const AdminDashboardPage = React.lazy(() => import('@/pages/AdminDashboard').then(m => ({ default: m.AdminDashboardPage })));
const AdminWorkspaceDetailPage = React.lazy(() => import('@/pages/AdminWorkspaceDetail').then(m => ({ default: m.AdminWorkspaceDetailPage })));
const WorkspaceSettingsPage = React.lazy(() => import('@/pages/WorkspaceSettings').then(m => ({ default: m.WorkspaceSettingsPage })));
const FleetGraphSettingsPage = React.lazy(() => import('@/pages/FleetGraphSettings').then(m => ({ default: m.FleetGraphSettingsPage })));
const ConvertedDocumentsPage = React.lazy(() => import('@/pages/ConvertedDocuments').then(m => ({ default: m.ConvertedDocumentsPage })));
const UnifiedDocumentPage = React.lazy(() => import('@/pages/UnifiedDocumentPage').then(m => ({ default: m.UnifiedDocumentPage })));
const StatusOverviewPage = React.lazy(() => import('@/pages/StatusOverviewPage').then(m => ({ default: m.StatusOverviewPage })));
const ReviewsPage = React.lazy(() => import('@/pages/ReviewsPage').then(m => ({ default: m.ReviewsPage })));
const OrgChartPage = React.lazy(() => import('@/pages/OrgChartPage').then(m => ({ default: m.OrgChartPage })));

/**
 * Redirect component for type-specific routes to canonical /documents/:id
 * Uses replace to ensure browser history only has one entry
 */
function DocumentRedirect() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`/documents/${id}`} replace />;
}

/**
 * Redirect component for /programs/:id/* routes to /documents/:id/*
 * Preserves the tab portion of the path (issues, projects, sprints)
 */
function ProgramTabRedirect() {
  const { id, '*': splat } = useParams<{ id: string; '*': string }>();
  const tab = splat || '';
  const targetPath = tab ? `/documents/${id}/${tab}` : `/documents/${id}`;
  return <Navigate to={targetPath} replace />;
}

/**
 * Redirect component for /sprints/:id/* routes to /documents/:id/*
 * Maps old sprint sub-routes to new unified document tab routes
 */
function SprintTabRedirect({ tab }: { tab?: string }) {
  const { id } = useParams<{ id: string }>();
  // Map 'planning' to 'plan' for consistency
  const mappedTab = tab === 'planning' ? 'plan' : tab;
  // 'view' maps to root (overview tab)
  const targetPath = mappedTab && mappedTab !== 'view'
    ? `/documents/${id}/${mappedTab}`
    : `/documents/${id}`;
  return <Navigate to={targetPath} replace />;
}

function PlaceholderPage({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center">
      <h1 className="text-xl font-medium text-foreground">{title}</h1>
      <p className="mt-1 text-sm text-muted">{subtitle}</p>
    </div>
  );
}

function PublicRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="text-muted">Loading...</div>
      </div>
    );
  }

  if (user) {
    return <Navigate to="/docs" replace />;
  }

  return <>{children}</>;
}

function SuperAdminRoute({ children }: { children: React.ReactNode }) {
  const { user, loading, isSuperAdmin } = useAuth();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="text-muted">Loading...</div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (!isSuperAdmin) {
    return <Navigate to="/docs" replace />;
  }

  return <>{children}</>;
}

function App() {
  return (
    <Routes>
      {/* Truly public routes - no AuthProvider wrapper */}
      <Route
        path="/feedback/:programId"
        element={<PublicFeedbackPage />}
      />
      {/* Routes that need AuthProvider (even if some are public) */}
      <Route
        path="/*"
        element={
          <WorkspaceProvider>
            <AuthProvider>
              <RealtimeEventsProvider>
                <AppRoutes />
              </RealtimeEventsProvider>
            </AuthProvider>
          </WorkspaceProvider>
        }
      />
    </Routes>
  );
}

function AppRoutes() {
  return (
    <React.Suspense
      fallback={
        <div className="flex h-screen items-center justify-center bg-background">
          <div className="text-muted">Loading...</div>
        </div>
      }
    >
      <Routes>
      <Route
        path="/setup"
        element={<SetupPage />}
      />
      <Route
        path="/login"
        element={
          <PublicRoute>
            <LoginPage />
          </PublicRoute>
        }
      />
      <Route
        path="/invite/:token"
        element={<InviteAcceptPage />}
      />
      <Route
        path="/admin"
        element={
          <SuperAdminRoute>
            <AdminDashboardPage />
          </SuperAdminRoute>
        }
      />
      <Route
        path="/admin/workspaces/:id"
        element={
          <SuperAdminRoute>
            <AdminWorkspaceDetailPage />
          </SuperAdminRoute>
        }
      />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <CurrentDocumentProvider>
              <FleetChatProvider>
                <ArchivedPersonsProvider>
                  <DocumentsProvider>
                    <ProgramsProvider>
                      <ProjectsProvider>
                        <IssuesProvider>
                          <UploadProvider>
                            <AppLayout />
                          </UploadProvider>
                        </IssuesProvider>
                      </ProjectsProvider>
                    </ProgramsProvider>
                  </DocumentsProvider>
                </ArchivedPersonsProvider>
              </FleetChatProvider>
            </CurrentDocumentProvider>
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/my-week" replace />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="my-week" element={<MyWeekPage />} />
        <Route path="docs" element={<DocumentsPage />} />
        <Route path="docs/:id" element={<DocumentRedirect />} />
        <Route path="documents/:id/*" element={<UnifiedDocumentPage />} />
        <Route path="issues" element={<IssuesPage />} />
        <Route path="issues/:id" element={<DocumentRedirect />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="projects/:id" element={<DocumentRedirect />} />
        <Route path="insights" element={<InsightsPage />} />
        <Route path="programs" element={<ProgramsPage />} />
        <Route path="programs/:programId/sprints/:id" element={<DocumentRedirect />} />
        <Route path="programs/:id/*" element={<ProgramTabRedirect />} />
        <Route path="sprints" element={<Navigate to="/team/allocation" replace />} />
        {/* Sprint routes - redirect legacy views to /documents/:id, keep planning workflow */}
        <Route path="sprints/:id" element={<DocumentRedirect />} />
        <Route path="sprints/:id/view" element={<SprintTabRedirect tab="view" />} />
        <Route path="sprints/:id/plan" element={<SprintTabRedirect tab="plan" />} />
        <Route path="sprints/:id/planning" element={<SprintTabRedirect tab="planning" />} />
        <Route path="sprints/:id/standups" element={<SprintTabRedirect tab="standups" />} />
        <Route path="sprints/:id/review" element={<SprintTabRedirect tab="review" />} />
        <Route path="team" element={<Navigate to="/team/allocation" replace />} />
        <Route path="team/allocation" element={<TeamModePage />} />
        <Route path="team/directory" element={<TeamDirectoryPage />} />
        <Route path="team/status" element={<StatusOverviewPage />} />
        <Route path="team/reviews" element={<ReviewsPage />} />
        <Route path="team/org-chart" element={<OrgChartPage />} />
        {/* Person profile stays in Teams context - no redirect to /documents */}
        <Route path="team/:id" element={<PersonEditorPage />} />
        <Route path="feedback/:id" element={<FeedbackEditorPage />} />
        <Route path="settings" element={<WorkspaceSettingsPage />} />
        <Route path="settings/conversions" element={<ConvertedDocumentsPage />} />
        <Route path="settings/fleet" element={<FleetGraphSettingsPage />} />
      </Route>
      </Routes>
    </React.Suspense>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{ persister: queryPersister }}
    >
      <ToastProvider>
        <MutationErrorToast />
        <BrowserRouter>
          <ReviewQueueProvider>
            <App />
          </ReviewQueueProvider>
        </BrowserRouter>
      </ToastProvider>
      <ReactQueryDevtools initialIsOpen={false} />
    </PersistQueryClientProvider>
  </React.StrictMode>
);
