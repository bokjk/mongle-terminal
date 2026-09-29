import { QRCodeSVG } from 'qrcode.react';

function httpsOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.origin.length > 2048) return null;
    return url.origin;
  } catch { return null; }
}

export function RemoteAccessQr({ origin }: { origin: string }) {
  const address = httpsOrigin(origin);
  if (!address) return null;
  return <figure className="remote-access-qr">
    <QRCodeSVG value={address} size={232} level="M" marginSize={4} bgColor="#ffffff" fgColor="#000000" role="img" aria-label="모바일 원격 접속 QR 코드" title="모바일 원격 접속 QR 코드" />
    <figcaption>
      <h4 className="settings-title">휴대폰으로 QR 코드 스캔</h4>
      <p className="hint">휴대폰에서 Tailscale을 켜고 카메라로 스캔하면 접속 주소가 열립니다.</p>
      <p className="hint">처음 연결할 때는 아래에서 연결 코드를 만든 뒤 휴대폰에 입력하고, 이 컴퓨터에서 기기를 승인해 주세요.</p>
    </figcaption>
  </figure>;
}
