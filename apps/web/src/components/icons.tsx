import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 24, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

const paths = {
  tasks: (
    <>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="m3 6 1.5 1.5L7 5M3 12l1.5 1.5L7 11M3 18l1.5 1.5L7 17" />
    </>
  ),
  receive: (
    <>
      <path d="M12 3v10m0 0-4-4m4 4 4-4" />
      <path d="M4 14v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5" />
    </>
  ),
  qc: (
    <>
      <path d="M12 3 5 6v5c0 4.5 3 8.5 7 10 4-1.500 7-5.500 7-10V6l-7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  putaway: (
    <>
      <path d="M3 21V8l9-5 9 5v13" />
      <path d="M8 21v-7h8v7M8 17.500h8" />
    </>
  ),
  pick: (
    <>
      <path d="M21 8 12 3 3 8v8l9 5 9-5V8Z" />
      <path d="M3 8l9 5 9-5M12 13v8" />
    </>
  ),
  load: (
    <>
      <path d="M2 6h11v10H2zM13 9h4l4 4v3h-8" />
      <circle cx="6.500" cy="17.500" r="1.800" />
      <circle cx="17" cy="17.500" r="1.800" />
    </>
  ),
  count: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M9 7h6M9 12h.01M12 12h.01M15 12h.01M9 16h.01M12 16h.01M15 16h.01" />
    </>
  ),
  transfer: (
    <>
      <path d="M4 8h15m0 0-4-4m4 4-4 4" />
      <path d="M20 16H5m0 0 4-4m-4 4 4 4" />
    </>
  ),
  query: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.500-3.500" />
    </>
  ),
  home: (
    <>
      <path d="m3 11 9-8 9 8" />
      <path d="M5 10v10h14V10" />
    </>
  ),
  outbox: (
    <>
      <path d="M12 16V4m0 0-4 4m4-4 4 4" />
      <path d="M4 14v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5" />
    </>
  ),
  keyboard: (
    <>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
    </>
  ),
  barcode: <path d="M4 5v14M7 5v14M11 5v14M14 5v14M17 5v14M20 5v14" />,
  check: <path d="m5 12 5 5 9-10" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  alert: (
    <>
      <path d="M12 3 2 20h20L12 3Z" />
      <path d="M12 10v4M12 17h.01" />
    </>
  ),
  chevronLeft: <path d="m15 5-7 7 7 7" />,
  chevronRight: <path d="m9 5 7 7-7 7" />,
  signOut: (
    <>
      <path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4" />
      <path d="M10 12h-7m0 0 3-3m-3 3 3 3M10 12h4" />
    </>
  ),
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  wifiOff: (
    <>
      <path d="m3 3 18 18" />
      <path d="M8.500 16.500a5 5 0 0 1 7 0M5 13a10 10 0 0 1 4-2.500M19 13a10 10 0 0 0-5-2.800M2 9.500A15 15 0 0 1 6 7M22 9.500A15 15 0 0 0 11 5" />
      <path d="M12 20h.01" />
    </>
  ),
  dashboard: (
    <>
      <rect x="3" y="3" width="8" height="10" rx="1" />
      <rect x="13" y="3" width="8" height="6" rx="1" />
      <rect x="13" y="11" width="8" height="10" rx="1" />
      <rect x="3" y="15" width="8" height="6" rx="1" />
    </>
  ),
  stock: (
    <>
      <path d="M3 21V8l9-5 9 5v13" />
      <path d="M7 21v-4h4v4M13 21v-4h4v4M10 17v-4h4v4" />
    </>
  ),
  orders: (
    <>
      <path d="M7 3h10a2 2 0 0 1 2 2v16l-3-2-2 2-2-2-2 2-2-2-3 2V5a2 2 0 0 1 2-2Z" />
      <path d="M9 8h6M9 12h6" />
    </>
  ),
  supply: (
    <>
      <path d="M3 21V10l6 4v-4l6 4V5h6v16H3Z" />
      <path d="M7 17h.01M11 17h.01M15 17h.01" />
    </>
  ),
  planning: (
    <>
      <path d="M3 3v18h18" />
      <path d="m7 15 4-5 3 3 5-7" />
    </>
  ),
  campaigns: (
    <>
      <path d="M3 10v4h3l8 5V5l-8 5H3Z" />
      <path d="M18 9a4 4 0 0 1 0 6" />
    </>
  ),
  dealers: (
    <>
      <path d="M3 9 5 4h14l2 5M4 9v11h16V9" />
      <path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0M9 20v-6h6v6" />
    </>
  ),
  reconciliation: (
    <>
      <path d="M12 3v18M5 7h14" />
      <path d="M5 7 2 14a3.500 3.500 0 0 0 6 0L5 7ZM19 7l-3 7a3.500 3.500 0 0 0 6 0l-3-7ZM8 21h8" />
    </>
  ),
  approvals: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  alerts: (
    <>
      <path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4l2-2Z" />
      <path d="M10 21h4" />
    </>
  ),
  masters: (
    <>
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <path d="M4 6v6c0 1.700 3.600 3 8 3s8-1.300 8-3V6M4 12v6c0 1.700 3.600 3 8 3s8-1.300 8-3v-6" />
    </>
  ),
  audit: (
    <>
      <path d="M6 3h9l4 4v14H6V3Z" />
      <path d="M14 3v5h5M9 13h7M9 17h7" />
    </>
  ),
} as const;

export type IconName = keyof typeof paths | 'shipping';

export function Icon({ name, ...rest }: IconProps & { name: IconName }) {
  return <Svg {...rest}>{paths[name === 'shipping' ? 'load' : name]}</Svg>;
}
