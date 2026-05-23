/**
 * AI-powered quality assistant components for weekly plan and retro editors.
 *
 * PlanQualityAssistant: Shows approval likelihood meter, per-item feedback, and quality guide.
 * RetroQualityAssistant: Shows plan coverage, evidence prompts, and completeness meter.
 *
 * Both are ADVISORY ONLY — they do not block document submission.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { cn } from '@/lib/cn';

// Use raw fetch for AI quality checks — these are non-critical background requests
// that must NOT trigger session expiration redirects (apiGet/apiPost do that on 401).
const API_URL = import.meta.env.VITE_API_URL ?? '';

let quietCsrfToken: string | null = null;

async function getQuietCsrfToken(): Promise<string | null> {
  if (quietCsrfToken) return quietCsrfToken;
  try {
    const res = await fetch(`${API_URL}/api/csrf-token`, { credentials: 'include' });
    if (!res.ok) return null;
    const data = await res.json();
    quietCsrfToken = data.token;
    return quietCsrfToken;
  } catch {
    return null;
  }
}

async function quietGet(endpoint: string): Promise<Response> {
  return fetch(`${API_URL}${endpoint}`, { credentials: 'include' });
}

async function quietPost(endpoint: string, body: object): Promise<Response> {
  const token = await getQuietCsrfToken();
  return fetch(`${API_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-CSRF-Token': token } : {}),
    },
    credentials: 'include',
    body: JSON.stringify(body),
  });
}

// ============ Shared Types ============

interface PlanItemAnalysis {
  text: string;
  score: number;
  feedback: string;
  issues: string[];
}

interface PlanAnalysisResult {
  overall_score: number;
  items: PlanItemAnalysis[];
  workload_assessment: 'light' | 'moderate' | 'heavy' | 'excessive';
  workload_feedback: string;
}

interface RetroItemAnalysis {
  plan_item: string;
  addressed: boolean;
  has_evidence: boolean;
  feedback: string;
}

interface RetroAnalysisResult {
  overall_score: number;
  plan_coverage: RetroItemAnalysis[];
  suggestions: string[];
}

type AnalysisError = { error: string };

function isError(result: unknown): result is AnalysisError {
  return !!result && typeof result === 'object' && 'error' in result;
}

// ============ Quality Meter ============

function QualityMeter({ score, label }: { score: number; label: string }) {
  const percentage = Math.round(score * 100);
  const color = percentage >= 70 ? 'bg-green-500' : percentage >= 40 ? 'bg-yellow-500' : 'bg-red-500';
  const textColor = percentage >= 70 ? 'text-green-500' : percentage >= 40 ? 'text-yellow-500' : 'text-red-500';

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-muted">{label}</span>
        <span className={cn('text-xs font-bold', textColor)}>{percentage}%</span>
      </div>
      <div className="w-full h-2 rounded-full bg-border overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all duration-500', color)}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}

// ============ Workload Badge ============

const WORKLOAD_CONFIG = {
  light: { label: 'Light', color: 'text-yellow-500 bg-yellow-500/10', desc: 'Consider adding more deliverables' },
  moderate: { label: 'Moderate', color: 'text-green-500 bg-green-500/10', desc: 'Good amount of work' },
  heavy: { label: 'Heavy', color: 'text-blue-500 bg-blue-500/10', desc: 'Ambitious but achievable' },
  excessive: { label: 'Excessive', color: 'text-red-500 bg-red-500/10', desc: 'May be unrealistic' },
};

function WorkloadBadge({ assessment }: { assessment: keyof typeof WORKLOAD_CONFIG }) {
  const config = WORKLOAD_CONFIG[assessment];
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted">Workload:</span>
      <span className={cn('px-2 py-0.5 rounded text-xs font-medium', config.color)}>
        {config.label}
      </span>
    </div>
  );
}

// ============ Expandable Guide ============

function ExpandableGuide({ title, children }: { title: string; children: React.ReactNode }) {
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem('ship_quality_guide_expanded') !== 'false';
    } catch { return true; }
  });

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    try { localStorage.setItem('ship_quality_guide_expanded', String(next)); } catch { /* ignore */ }
  };

  return (
    <div className="border border-border rounded">
      <button onClick={toggle} className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-muted hover:text-foreground">
        {title}
        <svg className={cn('w-3 h-3 transition-transform', expanded && 'rotate-180')} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {expanded && <div className="px-3 pb-3 text-xs text-muted space-y-2">{children}</div>}
    </div>
  );
}

// ============ Plan Quality Assistant ============

export function PlanQualityAssistant({
  documentId,
}: {
  documentId: string;
  content: Record<string, unknown>;
}) {
  const [analysis, setAnalysis] = useState<PlanAnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [aiAvailable, setAiAvailable] = useState<boolean | null>(null);
  const lastContentRef = useRef<string>('');
  const pollRef = useRef<ReturnType<typeof setInterval>>();

  // Check AI availability on mount
  useEffect(() => {
    quietGet('/api/ai/status')
      .then(r => r.json())
      .then(data => setAiAvailable(data.available))
      .catch(() => setAiAvailable(false));
  }, []);

  // Analyze content by fetching latest from API
  const checkAndAnalyze = useCallback(async () => {
    if (!aiAvailable) return;

    try {
      // Fetch the latest saved content from the API
      const docRes = await quietGet(`/api/documents/${documentId}`);
      if (!docRes.ok) return;
      const doc = await docRes.json();
      const content = doc.content;
      if (!content) return;

      const contentStr = JSON.stringify(content);
      if (contentStr === lastContentRef.current) return;
      lastContentRef.current = contentStr;

      // Content changed — trigger analysis
      setLoading(true);
      const res = await quietPost('/api/ai/analyze-plan', { content });
      const data = await res.json();
      if (!isError(data)) {
        setAnalysis(data);
      }
    } catch { /* keep previous analysis */ }
    finally { setLoading(false); }
  }, [documentId, aiAvailable]);

  // Poll for content changes every 10 seconds
  useEffect(() => {
    if (!aiAvailable) return;

    // Initial check after 5 seconds
    const initialTimeout = setTimeout(checkAndAnalyze, 5000);

    // Then poll every 10 seconds
    pollRef.current = setInterval(checkAndAnalyze, 10000);

    return () => {
      clearTimeout(initialTimeout);
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [aiAvailable, checkAndAnalyze]);

  // Don't render if AI is unavailable
  if (aiAvailable === false) return null;
  if (aiAvailable === null) return null; // Still checking

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium text-muted">AI Quality Check</div>
        {loading && (
          <svg className="w-3 h-3 animate-spin text-muted" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        )}
      </div>

      {analysis ? (
        <div className="space-y-3">
          <QualityMeter score={analysis.overall_score} label="Approval Likelihood" />
          <WorkloadBadge assessment={analysis.workload_assessment} />

          {/* Per-item feedback */}
          {analysis.items.length > 0 && (
            <div className="space-y-1.5">
              <span className="text-xs text-muted">Item Feedback</span>
              {analysis.items.map((item, i) => (
                <div key={i} className={cn(
                  'rounded border px-2 py-1.5 text-xs',
                  item.score >= 0.7 ? 'border-green-500/20 bg-green-500/5' :
                  item.score >= 0.4 ? 'border-yellow-500/20 bg-yellow-500/5' :
                  'border-red-500/20 bg-red-500/5'
                )}>
                  <p className="font-medium text-foreground truncate">{item.text}</p>
                  <p className="text-muted mt-0.5">{item.feedback}</p>
                </div>
              ))}
            </div>
          )}

          {analysis.workload_feedback && (
            <p className="text-xs text-muted italic">{analysis.workload_feedback}</p>
          )}
        </div>
      ) : !loading ? (
        <p className="text-xs text-muted italic">Write your plan items to get AI feedback.</p>
      ) : null}

      <ExpandableGuide title="Writing a Good Plan">
        <p>Each item should have a <strong className="text-foreground">clear, verifiable outcome</strong>.</p>
        <div className="space-y-1 mt-1">
          <p><span className="text-red-400">Bad:</span> "Coordinate with engineering"</p>
          <p><span className="text-green-400">Good:</span> "Deliver draft API spec to engineering lead"</p>
        </div>
        <div className="space-y-1">
          <p><span className="text-red-400">Bad:</span> "Investigate deployment options"</p>
          <p><span className="text-green-400">Good:</span> "Write comparison memo of 3 deployment options"</p>
        </div>
        <p className="mt-1">Aim for <strong className="text-foreground">3-5 significant deliverables</strong> per week.</p>
        <p className="text-muted mt-1 italic">This feedback is advisory — it does not block your submission.</p>
      </ExpandableGuide>
    </div>
  );
}

// ============ Retro Quality Assistant ============

export function RetroQualityAssistant({
  documentId,
  planContent,
}: {
  documentId: string;
  content: Record<string, unknown>;
  planContent: Record<string, unknown> | null;
}) {
  const [analysis, setAnalysis] = useState<RetroAnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [aiAvailable, setAiAvailable] = useState<boolean | null>(null);
  const lastContentRef = useRef<string>('');
  const pollRef = useRef<ReturnType<typeof setInterval>>();

  // Check AI availability on mount
  useEffect(() => {
    quietGet('/api/ai/status')
      .then(r => r.json())
      .then(data => setAiAvailable(data.available))
      .catch(() => setAiAvailable(false));
  }, []);

  // Analyze content by fetching latest from API
  const checkAndAnalyze = useCallback(async () => {
    if (!aiAvailable || !planContent) return;

    try {
      // Fetch the latest saved content from the API
      const docRes = await quietGet(`/api/documents/${documentId}`);
      if (!docRes.ok) return;
      const doc = await docRes.json();
      const content = doc.content;
      if (!content) return;

      const contentStr = JSON.stringify(content);
      if (contentStr === lastContentRef.current) return;
      lastContentRef.current = contentStr;

      // Content changed — trigger analysis
      setLoading(true);
      const res = await quietPost('/api/ai/analyze-retro', { retro_content: content, plan_content: planContent });
      const data = await res.json();
      if (!isError(data)) {
        setAnalysis(data);
      }
    } catch { /* keep previous analysis */ }
    finally { setLoading(false); }
  }, [documentId, aiAvailable, planContent]);

  // Poll for content changes every 10 seconds
  useEffect(() => {
    if (!aiAvailable || !planContent) return;

    const initialTimeout = setTimeout(checkAndAnalyze, 5000);
    pollRef.current = setInterval(checkAndAnalyze, 10000);

    return () => {
      clearTimeout(initialTimeout);
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [aiAvailable, planContent, checkAndAnalyze]);

  // Don't render if AI is unavailable
  if (aiAvailable === false) return null;
  if (aiAvailable === null) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium text-muted">AI Quality Check</div>
        {loading && (
          <svg className="w-3 h-3 animate-spin text-muted" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        )}
      </div>

      {analysis ? (
        <div className="space-y-3">
          <QualityMeter score={analysis.overall_score} label="Retro Completeness" />

          {/* Plan coverage checklist */}
          {analysis.plan_coverage.length > 0 && (
            <div className="space-y-1.5">
              <span className="text-xs text-muted">Plan Coverage</span>
              {analysis.plan_coverage.map((item, i) => (
                <div key={i} className={cn(
                  'rounded border px-2 py-1.5 text-xs flex items-start gap-2',
                  item.addressed && item.has_evidence ? 'border-green-500/20 bg-green-500/5' :
                  item.addressed ? 'border-yellow-500/20 bg-yellow-500/5' :
                  'border-red-500/20 bg-red-500/5'
                )}>
                  {/* Status icon */}
                  <span className="mt-0.5 flex-shrink-0">
                    {item.addressed && item.has_evidence ? (
                      <svg className="w-3.5 h-3.5 text-green-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M20 6L9 17l-5-5" /></svg>
                    ) : item.addressed ? (
                      <svg className="w-3.5 h-3.5 text-yellow-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M12 9v2m0 4h.01" /><circle cx="12" cy="12" r="10" strokeWidth="2" /></svg>
                    ) : (
                      <svg className="w-3.5 h-3.5 text-red-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M18 6L6 18M6 6l12 12" /></svg>
                    )}
                  </span>
                  <div className="min-w-0">
                    <p className="font-medium text-foreground truncate">{item.plan_item}</p>
                    <p className="text-muted mt-0.5">{item.feedback}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Suggestions */}
          {analysis.suggestions.length > 0 && (
            <div className="space-y-1">
              <span className="text-xs text-muted">Suggestions</span>
              {analysis.suggestions.map((s, i) => (
                <p key={i} className="text-xs text-muted italic">• {s}</p>
              ))}
            </div>
          )}
        </div>
      ) : !loading ? (
        <p className="text-xs text-muted italic">
          {planContent ? 'Write your retro to get AI feedback.' : 'No plan found for comparison.'}
        </p>
      ) : null}

      <ExpandableGuide title="Writing a Good Retro">
        <p><strong className="text-foreground">Address each item from your plan:</strong></p>
        <ul className="list-disc pl-4 space-y-0.5">
          <li>Completed? Add evidence (link, screenshot, or the deliverable itself)</li>
          <li>Not completed? Explain what happened and why</li>
          <li>It's OK to not deliver everything — but always explain why</li>
        </ul>
        <p className="mt-1 italic">This feedback is advisory — it does not block your submission.</p>
      </ExpandableGuide>
    </div>
  );
}
