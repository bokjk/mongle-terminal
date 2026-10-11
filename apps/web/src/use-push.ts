import { useEffect, useState } from 'react';
import type { AppClient, ConnectionInfo } from '../../../packages/client/index';
import { clearShownNotifications, notificationTarget, type NotificationTarget } from './push';

/**
 * Tells this PC whether its screen is in view in this browser, so the PC holds phone
 * notifications meanwhile (packages/host/gateway.ts presence.update). The PC app reports its
 * own window from the main process instead.
 */
export function usePushPresence(client: AppClient, connection: ConnectionInfo, supported: boolean) {
  useEffect(() => {
    if (window.mongle || connection.status !== 'connected' || !supported) return;
    let reported: boolean | undefined;
    const send = (active: boolean) => {
      if (active === reported) return;
      reported = active;
      void client.request('presence.update', { active }).catch(() => { if (reported === active) reported = undefined; });
    };
    const report = () => {
      const active = document.visibilityState === 'visible';
      if (active) clearShownNotifications();
      send(active);
    };
    const leave = () => send(false);
    report();
    document.addEventListener('visibilitychange', report);
    window.addEventListener('pageshow', report);
    window.addEventListener('pagehide', leave);
    return () => {
      document.removeEventListener('visibilitychange', report);
      window.removeEventListener('pageshow', report);
      window.removeEventListener('pagehide', leave);
    };
  }, [client, connection.status, connection.connectionId, supported]);
}

/** A tapped notification opens its terminal or the new device approval here (public/sw.js). */
export function useNotificationTarget(): [NotificationTarget | undefined, () => void] {
  const [target, setTarget] = useState<NotificationTarget | undefined>(() => notificationTarget(location.href));
  useEffect(() => {
    const query = new URLSearchParams(location.search);
    if (query.has('terminal') || query.has('open')) history.replaceState(history.state, '', location.pathname + location.hash);
    if (window.mongle || !('serviceWorker' in navigator)) return;
    const received = (event: MessageEvent) => {
      if (event.data?.type !== 'mongle.notification' || typeof event.data.url !== 'string') return;
      const next = notificationTarget(event.data.url);
      if (next) setTarget(next);
    };
    navigator.serviceWorker.addEventListener('message', received);
    return () => navigator.serviceWorker.removeEventListener('message', received);
  }, []);
  return [target, () => setTarget(undefined)];
}
