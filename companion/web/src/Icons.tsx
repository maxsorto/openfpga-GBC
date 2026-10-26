// Small line icons, 16px by default, drawn with currentColor.
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 16, ...rest }: P) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    ...rest,
  };
}

export const IconCard = (p: P) => (
  <svg {...base(p)}>
    <path d="M5 1.75h6.5l2.25 2.25v9.5a.75.75 0 0 1-.75.75H5a.75.75 0 0 1-.75-.75V2.5A.75.75 0 0 1 5 1.75z" />
    <path d="M7 4.5v2M9 4.5v2M11 4.5v2" />
  </svg>
);

export const IconFolder = (p: P) => (
  <svg {...base(p)}>
    <path d="M1.75 4.25a1 1 0 0 1 1-1h3.1l1.4 1.5h6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z" />
  </svg>
);

export const IconChevron = (p: P) => (
  <svg {...base(p)}>
    <path d="M4.5 6.25 8 9.75l3.5-3.5" />
  </svg>
);

export const IconSearch = (p: P) => (
  <svg {...base(p)}>
    <circle cx="7" cy="7" r="4.25" />
    <path d="m10.25 10.25 3.5 3.5" />
  </svg>
);

export const IconCheck = (p: P) => (
  <svg {...base(p)}>
    <path d="m3.5 8.25 3 3 6-6.5" />
  </svg>
);

export const IconPencil = (p: P) => (
  <svg {...base(p)}>
    <path d="M10.75 2.75 13.25 5.25 5.5 13H3v-2.5z" />
  </svg>
);

export const IconEject = (p: P) => (
  <svg {...base(p)}>
    <path d="M8 3 3.25 8.75h9.5z" />
    <path d="M3.25 12.25h9.5" />
  </svg>
);

export const IconImage = (p: P) => (
  <svg {...base(p)}>
    <rect x="2" y="2.75" width="12" height="10.5" rx="1.5" />
    <circle cx="5.75" cy="6.25" r="1.1" />
    <path d="m2.5 11.75 3.5-3.25 2.5 2.25 2-1.75 3 2.75" />
  </svg>
);

export const IconWarn = (p: P) => (
  <svg {...base(p)}>
    <path d="M8 2.25 14.25 13.25H1.75z" />
    <path d="M8 6.5v3M8 11.4v.1" />
  </svg>
);

export const IconRefresh = (p: P) => (
  <svg {...base(p)}>
    <path d="M13 8a5 5 0 1 1-1.5-3.55" />
    <path d="M13 2.75v2.5h-2.5" />
  </svg>
);

export const IconClose = (p: P) => (
  <svg {...base(p)}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </svg>
);
