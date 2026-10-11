import type { Transport } from '../../../packages/protocol/index';

/** desktop: the PC app shows its own window. Others describe why this browser cannot turn notifications on. */
export type PushAvailability = 'ready' | 'desktop' | 'insecure' | 'unsupported' | 'install-first';
export type PushStatus = { publicKey: string; subscribed: boolean; endpoint?: string };
export type PushView = { host: PushStatus; local: PushSubscription | null; permission: NotificationPermission };

/** Web Push needs a secure page, a service worker and the Push API. iPhone and iPad offer it only to Home Screen web apps. */
export function pushAvailability(): PushAvailability {
  if (window.mongle) return 'desktop';
  if (!window.isSecureContext) return 'insecure';
  if ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window) return 'ready';
  const apple = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return apple ? 'install-first' : 'unsupported';
}

/** Registers the notification worker (public/sw.js) for browser views of a PC. It caches nothing. */
export function registerNotificationWorker(): Promise<ServiceWorkerRegistration | undefined> {
  if (window.mongle || !window.isSecureContext || !('serviceWorker' in navigator)) return Promise.resolve(undefined);
  return navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
}

function keyBytes(value: string): Uint8Array<ArrayBuffer> {
  const text = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(text.length));
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
  return bytes;
}
function sameKey(key: ArrayBuffer | null | undefined, publicKey: string): boolean {
  if (!key) return false;
  const a = new Uint8Array(key), b = keyBytes(publicKey);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
async function activeWorker(): Promise<ServiceWorkerRegistration> {
  if (!(await registerNotificationWorker())) throw new Error('이 브라우저에서는 알림을 켤 수 없습니다.');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('알림 준비가 늦어지고 있습니다. 화면을 새로 고친 뒤 다시 시도해 주세요.')), 10_000); });
  try { return await Promise.race([navigator.serviceWorker.ready, late]); } finally { clearTimeout(timer); }
}

export async function readPushView(client: Transport): Promise<PushView> {
  const host = await client.request<PushStatus>('push.status', {});
  const registration = await navigator.serviceWorker.getRegistration('/');
  return { host, local: registration ? await registration.pushManager.getSubscription() : null, permission: Notification.permission };
}
/** On only when this PC holds this browser's current subscription for its own key. */
export function pushOn(view: PushView): boolean {
  return view.permission === 'granted' && !!view.local && view.host.subscribed && view.host.endpoint === view.local.endpoint
    && sameKey(view.local.options.applicationServerKey, view.host.publicKey);
}

export async function enablePush(client: Transport): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission === 'denied') throw new Error('브라우저에서 이 주소의 알림이 차단되어 있습니다. 주소창의 사이트 설정에서 알림을 허용한 뒤 다시 눌러 주세요.');
  if (permission !== 'granted') throw new Error('알림 허용을 선택하지 않아 켜지 않았습니다.');
  const registration = await activeWorker();
  const host = await client.request<PushStatus>('push.status', {});
  let subscription = await registration.pushManager.getSubscription();
  // A subscription made for another key (the PC's data was reset) never receives this PC's messages.
  if (subscription && !sameKey(subscription.options.applicationServerKey, host.publicKey)) { await subscription.unsubscribe().catch(() => false); subscription = null; }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(host.publicKey) });
  const { endpoint, keys } = subscription.toJSON();
  await client.request('push.subscribe', { endpoint, keys: { p256dh: keys?.p256dh, auth: keys?.auth } });
}

export async function disablePush(client: Transport): Promise<void> {
  await client.request('push.unsubscribe', {});
  const registration = await navigator.serviceWorker.getRegistration('/');
  await (await registration?.pushManager.getSubscription())?.unsubscribe().catch(() => false);
}

/** Closes this PC's notifications once its screen is in view again. */
export function clearShownNotifications(): void {
  if (window.mongle || !('serviceWorker' in navigator)) return;
  void navigator.serviceWorker.getRegistration('/').then(registration => registration?.getNotifications()).then(list => list?.forEach(item => item.close())).catch(() => {});
}

export type NotificationTarget = { terminalId: string } | { open: 'pairing' };
/** The page a notification opens: '/?terminal=<id>' or '/?open=pairing' (see packages/host/push-notifier.ts). */
export function notificationTarget(url: string): NotificationTarget | undefined {
  let parsed: URL;
  try { parsed = new URL(url, location.origin); } catch { return undefined; }
  if (parsed.origin !== location.origin) return undefined;
  const terminalId = parsed.searchParams.get('terminal');
  if (terminalId && /^[0-9a-f-]{36}$/i.test(terminalId)) return { terminalId };
  if (parsed.searchParams.get('open') === 'pairing') return { open: 'pairing' };
  return undefined;
}
