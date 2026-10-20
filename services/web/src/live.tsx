import { createContext, ReactNode, useContext, useEffect, useRef, useState } from 'react';
import { getToken } from './api';

type Listener = (kind: string, data: any) => void;

interface Live {
  connected: boolean;
  subscribe: (fn: Listener) => () => void;
}

const Ctx = createContext<Live>({ connected: false, subscribe: () => () => undefined });
export const useLive = () => useContext(Ctx);

/** One server-sent-events connection for the whole app, re-opened if it drops. */
export function LiveProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const listeners = useRef(new Set<Listener>());

  useEffect(() => {
    let es: EventSource | null = null;
    let retry: number | undefined;
    const open = () => {
      const token = getToken();
      if (!token) return;
      es = new EventSource(`/api/events/stream?token=${encodeURIComponent(token)}`);
      es.onopen = () => setConnected(true);
      es.onerror = () => {
        setConnected(false);
        es?.close();
        retry = window.setTimeout(open, 3000);
      };
      for (const kind of ['event.created', 'event.reviewed', 'camera.status']) {
        es.addEventListener(kind, (m) => {
          const data = JSON.parse((m as MessageEvent).data);
          listeners.current.forEach((fn) => fn(kind, data));
        });
      }
    };
    open();
    return () => { es?.close(); window.clearTimeout(retry); };
  }, []);

  const subscribe = (fn: Listener) => {
    listeners.current.add(fn);
    return () => { listeners.current.delete(fn); };
  };

  return <Ctx.Provider value={{ connected, subscribe }}>{children}</Ctx.Provider>;
}

/** A short two-tone chime for critical alerts (WebAudio, no sound files needed). */
export function chime() {
  try {
    const ctx = new AudioContext();
    [880, 660].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.18);
      g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + i * 0.18 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.18 + 0.16);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.18);
      o.stop(ctx.currentTime + i * 0.18 + 0.17);
    });
  } catch { /* audio blocked until the user interacts */ }
}
