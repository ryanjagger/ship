import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useCallback,
  useState,
  type ReactNode,
} from 'react';
import { useAuth } from './useAuth';

// Event types that can be received from the server
export type RealtimeEventType = 'accountability:updated' | 'connected' | 'pong';

export interface RealtimeEvent {
  type: RealtimeEventType;
  data: Record<string, unknown>;
}

type EventCallback = (event: RealtimeEvent) => void;

export type RealtimeStatus = 'connected' | 'connecting' | 'reconnecting' | 'rate-limited' | 'disconnected';

interface RealtimeEventsContextType {
  isConnected: boolean;
  status: RealtimeStatus;
  subscribe: (eventType: RealtimeEventType, callback: EventCallback) => () => void;
}

const RealtimeEventsContext = createContext<RealtimeEventsContextType | null>(null);

// Exponential backoff with full jitter, capped at 30s.
// Server enforces 30 connections/IP/minute, so we must NOT reconnect on a fixed 3s timer.
const RECONNECT_BASE_MS = 1000;
const RECONNECT_CAP_MS = 30_000;
function computeReconnectDelay(attempt: number): number {
  const exp = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** attempt);
  return Math.floor(Math.random() * exp);
}

// WebSocket URLs for different environments
// VITE_WS_URL allows bypassing CloudFront (which doesn't support WebSocket)
// by connecting directly to the EB endpoint for real-time events
function getEventsWsUrl(): string {
  // Prefer explicit WebSocket URL (for CloudFront deployments)
  const wsUrl = import.meta.env.VITE_WS_URL;
  if (wsUrl) {
    return wsUrl.replace(/^http/, 'ws') + '/events';
  }

  // Fall back to API URL or current host
  const apiUrl = import.meta.env.VITE_API_URL ?? '';
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return apiUrl
    ? apiUrl.replace(/^http/, 'ws') + '/events'
    : `${wsProtocol}//${window.location.host}/events`;
}

export function RealtimeEventsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  // Reflects current intent — flipped to false by disconnect() (logout/unmount)
  // and read by every onclose handler before scheduling a reconnect. We can't
  // rely on the `user` closure inside onclose because that handler is registered
  // on the WebSocket at connect() time and keeps a stale value after logout.
  const shouldReconnectRef = useRef(false);
  const subscribersRef = useRef<Map<RealtimeEventType, Set<EventCallback>>>(new Map());
  const [isConnected, setIsConnected] = useState(false);
  const [status, setStatus] = useState<RealtimeStatus>('disconnected');

  // Subscribe to events
  const subscribe = useCallback((eventType: RealtimeEventType, callback: EventCallback) => {
    if (!subscribersRef.current.has(eventType)) {
      subscribersRef.current.set(eventType, new Set());
    }
    subscribersRef.current.get(eventType)!.add(callback);

    // Return unsubscribe function
    return () => {
      subscribersRef.current.get(eventType)?.delete(callback);
    };
  }, []);

  // Connect to WebSocket
  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    if (wsRef.current?.readyState === WebSocket.CONNECTING) return;
    if (wsRef.current?.readyState === WebSocket.CLOSING) return;

    shouldReconnectRef.current = true;
    setStatus((prev) => (prev === 'connected' ? prev : reconnectAttemptsRef.current > 0 ? 'reconnecting' : 'connecting'));

    const ws = new WebSocket(getEventsWsUrl());
    wsRef.current = ws;
    // Tracked per-connection so we can distinguish "closed after open"
    // from "upgrade rejected, never opened" in onclose. The browser hides
    // the upgrade-time HTTP status (429) from JS, so this flag is the only
    // signal we have to drive the 'rate-limited' UI state.
    let didOpen = false;

    ws.onopen = () => {
      console.log('[RealtimeEvents] Connected');
      didOpen = true;
      reconnectAttemptsRef.current = 0;
      setIsConnected(true);
      setStatus('connected');
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as RealtimeEvent;
        // Notify subscribers
        const callbacks = subscribersRef.current.get(data.type);
        if (callbacks) {
          callbacks.forEach((callback) => callback(data));
        }
      } catch (err) {
        console.error('[RealtimeEvents] Failed to parse message:', err);
      }
    };

    ws.onclose = () => {
      setIsConnected(false);
      // Only nullify if this is still the current WebSocket
      // (avoids race where a new WS was created before old one finished closing)
      if (wsRef.current === ws) {
        wsRef.current = null;
      }

      if (!shouldReconnectRef.current) {
        setStatus('disconnected');
        return;
      }

      const attempt = reconnectAttemptsRef.current;
      // Upgrade rejected without ever opening — most commonly 429 since session/access
      // errors are rarer. Reflect that in the UI so users see "rate-limited" instead
      // of perpetual "reconnecting" once we've retried a couple times.
      const likelyRateLimited = !didOpen && attempt >= 2;
      setStatus(likelyRateLimited ? 'rate-limited' : 'reconnecting');

      const delay = computeReconnectDelay(attempt);
      reconnectAttemptsRef.current = attempt + 1;
      // Log once on first close, then only every 5th retry to avoid console flood.
      if (attempt === 0 || attempt % 5 === 0) {
        console.log(`[RealtimeEvents] Reconnecting in ${delay}ms (attempt ${attempt + 1})`);
      }
      reconnectTimeoutRef.current = setTimeout(() => {
        connect();
      }, delay);
    };

    ws.onerror = () => {
      // Don't log: every reconnect attempt against a rate-limited server fires
      // onerror, and the close handler already drives the retry. Logging here
      // produced the audit's "198 console errors" finding.
      ws.close();
    };
  }, []);

  // Disconnect from WebSocket
  const disconnect = useCallback(() => {
    // Set this BEFORE closing the socket — onclose may fire synchronously in
    // some environments and will read this flag to decide whether to reconnect.
    shouldReconnectRef.current = false;
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    reconnectAttemptsRef.current = 0;
    setIsConnected(false);
    setStatus('disconnected');
  }, []);

  // Connect when user logs in, disconnect when they log out
  useEffect(() => {
    if (user) {
      connect();
    } else {
      disconnect();
    }

    return () => {
      disconnect();
    };
  }, [user, connect, disconnect]);

  // Keepalive ping every 30 seconds
  useEffect(() => {
    if (!isConnected) return;

    const pingInterval = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30000);

    return () => clearInterval(pingInterval);
  }, [isConnected]);

  return (
    <RealtimeEventsContext.Provider value={{ isConnected, status, subscribe }}>
      {children}
    </RealtimeEventsContext.Provider>
  );
}

export function useRealtimeEvents() {
  const context = useContext(RealtimeEventsContext);
  if (!context) {
    throw new Error('useRealtimeEvents must be used within RealtimeEventsProvider');
  }
  return context;
}

/**
 * Hook to listen for a specific realtime event type.
 * Automatically subscribes on mount and unsubscribes on unmount.
 */
export function useRealtimeEvent(eventType: RealtimeEventType, callback: EventCallback) {
  const { subscribe } = useRealtimeEvents();

  useEffect(() => {
    return subscribe(eventType, callback);
  }, [eventType, callback, subscribe]);
}
