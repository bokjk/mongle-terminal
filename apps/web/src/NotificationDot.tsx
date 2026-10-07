/** Status belongs to the enclosing row; the dot is not a tiny extra click target. */
export function NotificationDot({show}: {show: boolean}) {
  return show ? <span className="notification-dot" role="img" aria-label="확인할 알림" title="확인할 알림"/> : null;
}
