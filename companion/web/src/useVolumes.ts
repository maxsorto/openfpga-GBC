import { useEffect, useState } from 'react';
import { api, type Volume } from './api';

/** Poll mounted volumes so the app notices a card going in or out. */
export function useVolumes(intervalMs = 4000) {
  const [volumes, setVolumes] = useState<Volume[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const v = await api.volumes();
        if (alive) setVolumes(v);
      } catch {
        // keep the last list
      } finally {
        if (alive) setLoaded(true);
      }
    };
    void tick();
    const t = window.setInterval(tick, intervalMs);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [intervalMs]);
  return { volumes, loaded };
}
