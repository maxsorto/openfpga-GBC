// The inside of a Game Boy Color, seen through the Atomic Purple shell.
// One inline SVG, drawn simple and flat. CSS shows it only for the Atomic shell.
// The brightest parts (gold, screws, part ends) are toned so text over the
// purple tint keeps WCAG AA contrast; see the tint notes in styles.css.

const GOLD = '#BE9A52';
const COPPER = '#C9A35A';
const CHIP = '#151618';
const LABEL = '#4F5552';

// Copper traces: points with 45 degree bends.
const TRACES: string[] = [
  '360,250 360,330 420,390 640,390',
  '380,250 380,320 430,370 650,370',
  '400,250 400,310 440,350 660,350',
  '900,520 960,520 1000,480 1180,480',
  '900,560 980,560 1020,600 1180,600',
  '900,600 960,600 990,630 990,720 1030,760 1200,760',
  '700,700 700,760 660,800 420,800 380,840 380,900',
  '740,700 740,780 700,820 520,820',
  '780,700 780,800 820,840 1080,840 1120,880 1240,880',
  '560,520 480,520 440,560 440,680 400,720 300,720',
  '560,560 500,560 470,590 470,700 430,740 300,740',
  '1180,420 1260,420 1300,380 1300,250',
  '1200,440 1280,440 1320,400 1320,250',
  '640,140 640,190 600,230 600,300',
  '700,140 700,200 740,240 860,240 900,280 900,420',
  '760,140 760,190 790,220 980,220 1020,260 1020,420',
  '820,140 820,180 840,200 1100,200 1140,240 1140,420',
  '880,140 880,170 890,180 1200,180 1240,220 1240,330',
  '1440,300 1440,520 1400,560 1260,560',
  '200,420 200,560 240,600 300,600',
  '1060,700 1060,660 1100,620 1300,620 1340,660 1340,700',
];

const VIAS: [number, number][] = [
  [640, 390], [650, 370], [660, 350], [1180, 480], [1180, 600], [1200, 760], [380, 900], [520, 820],
  [1240, 880], [300, 720], [300, 740], [600, 300], [1240, 330], [1260, 560], [300, 600], [1340, 700],
  [1100, 300], [1160, 330], [470, 470], [820, 900], [960, 900], [1500, 420], [140, 520], [1000, 160],
];

// Small surface mount parts: x, y, width, height, kind.
const SMD: [number, number, number, number, 'r' | 'c'][] = [
  [480, 300, 26, 12, 'r'], [520, 300, 26, 12, 'c'], [560, 300, 26, 12, 'r'],
  [940, 430, 12, 26, 'c'], [960, 430, 12, 26, 'r'], [1210, 520, 26, 12, 'c'],
  [1210, 540, 26, 12, 'r'], [600, 760, 26, 12, 'r'], [640, 740, 26, 12, 'c'],
  [880, 760, 12, 26, 'r'], [1120, 700, 26, 12, 'c'], [260, 470, 26, 12, 'r'],
  [260, 490, 26, 12, 'c'], [1380, 300, 12, 26, 'r'], [1400, 300, 12, 26, 'c'],
  [1060, 300, 26, 12, 'r'],
];

const SCREWS: [number, number][] = [
  [130, 130], [1470, 130], [130, 870], [1470, 870],
];

function pinRow(x: number, y: number, n: number, pitch: number, w: number, h: number) {
  return Array.from({ length: n }, (_, i) => <rect key={i} x={x + i * pitch} y={y} width={w} height={h} />);
}

function speakerHoles(cx: number, cy: number) {
  const holes: JSX.Element[] = [<circle key="c" cx={cx} cy={cy} r={5} />];
  for (let ring = 1; ring <= 4; ring++) {
    const count = ring * 7;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      holes.push(<circle key={`${ring}-${i}`} cx={cx + Math.cos(a) * ring * 20} cy={cy + Math.sin(a) * ring * 20} r={5} />);
    }
  }
  return holes;
}

/** Button contact pad: interleaved rings, like the carbon pads under the rubber. */
function pad(cx: number, cy: number, r: number, key: string) {
  return (
    <g key={key}>
      <circle cx={cx} cy={cy} r={r} />
      <circle cx={cx} cy={cy} r={r * 0.66} />
      <circle cx={cx} cy={cy} r={r * 0.33} />
    </g>
  );
}

export function Board() {
  return (
    <svg className="board" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="pcb" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1E3B2A" />
          <stop offset="1" stopColor="#24452F" />
        </linearGradient>
      </defs>
      <rect width="1600" height="1000" fill="url(#pcb)" />

      {/* Board outline and silkscreen frame */}
      <rect x="40" y="40" width="1520" height="920" rx="36" fill="none" stroke="#2F5A3D" strokeWidth="3" />

      {/* Copper traces */}
      <g fill="none" stroke={COPPER} strokeOpacity="0.4" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        {TRACES.map((p, i) => (
          <polyline key={i} points={p} />
        ))}
      </g>

      {/* Vias */}
      <g fill="#14281C" stroke={COPPER} strokeOpacity="0.55" strokeWidth="3">
        {VIAS.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r="5" />
        ))}
      </g>

      {/* Cartridge edge connector along the top */}
      <g fill={GOLD} fillOpacity="0.75">
        {pinRow(560, 64, 32, 15, 9, 70)}
      </g>
      <rect x="548" y="56" width="494" height="86" rx="4" fill="none" stroke="#2F5A3D" strokeWidth="2" />

      {/* Ribbon cable up to the screen */}
      <g>
        <path d="M250 60 L250 200 Q250 240 290 240 L470 240 L470 260 L230 260 L230 60 Z" fill="#B8732E" fillOpacity="0.5" />
        <g stroke="#14281C" strokeOpacity="0.5" strokeWidth="1.5">
          {Array.from({ length: 6 }, (_, i) => (
            <line key={i} x1={234 + i * 3} y1="60" x2={234 + i * 3} y2="236" />
          ))}
        </g>
        <rect x="330" y="236" width="120" height="30" rx="3" fill={CHIP} />
        <g fill={GOLD} fillOpacity="0.6">{pinRow(338, 268, 13, 8, 4, 8)}</g>
      </g>

      {/* CPU, a QFP with pins on four sides */}
      <g>
        <rect x="560" y="430" width="300" height="250" rx="6" fill={CHIP} />
        <g fill="#8E949A" fillOpacity="0.7">
          {pinRow(580, 418, 33, 8, 4, 12)}
          {pinRow(580, 680, 33, 8, 4, 12)}
          <g transform="rotate(90 560 430)">{pinRow(578, 428, 27, 8, 4, 12)}</g>
          <g transform="rotate(90 860 430)">{pinRow(878, 128, 27, 8, 4, 12)}</g>
        </g>
        <circle cx="584" cy="454" r="7" fill="#232528" />
        <text x="710" y="548" textAnchor="middle" fill={LABEL} fontFamily="Space Mono, monospace" fontSize="22" letterSpacing="6">
          CPU CGB
        </text>
        <text x="710" y="580" textAnchor="middle" fill={LABEL} fillOpacity="0.8" fontFamily="Space Mono, monospace" fontSize="13" letterSpacing="3">
          NINTENDO 9839 JAPAN
        </text>
      </g>

      {/* RAM, a DIP style package */}
      <g>
        <rect x="960" y="380" width="200" height="86" rx="4" fill={CHIP} />
        <g fill="#8E949A" fillOpacity="0.7">
          {pinRow(972, 368, 14, 13.5, 6, 12)}
          {pinRow(972, 466, 14, 13.5, 6, 12)}
        </g>
        <circle cx="976" cy="423" r="5" fill="#232528" />
        <text x="1060" y="431" textAnchor="middle" fill={LABEL} fontFamily="Space Mono, monospace" fontSize="20" letterSpacing="6">
          RAM
        </text>
      </g>

      {/* Small regulator chip */}
      <g>
        <rect x="1240" y="640" width="110" height="80" rx="4" fill={CHIP} />
        <g fill="#8E949A" fillOpacity="0.7">
          {pinRow(1250, 630, 9, 11, 5, 10)}
          {pinRow(1250, 720, 9, 11, 5, 10)}
        </g>
      </g>

      {/* Crystal and electrolytic capacitors */}
      <rect x="900" y="300" width="70" height="30" rx="15" fill="#767C83" />
      <circle cx="1460" cy="640" r="30" fill="#1B2E22" stroke="#767C83" strokeWidth="4" />
      <circle cx="200" cy="330" r="26" fill="#1B2E22" stroke="#767C83" strokeWidth="4" />

      {/* Surface mount parts */}
      {SMD.map(([x, y, w, h, kind], i) => {
        const horizontal = w > h;
        const cap = horizontal ? { w: 6, h } : { w, h: 6 };
        return (
          <g key={i}>
            <rect x={x} y={y} width={w} height={h} fill={kind === 'c' ? '#A88550' : '#1A1B1D'} fillOpacity={kind === 'c' ? 0.8 : 1} />
            <rect x={x} y={y} width={cap.w} height={cap.h} fill="#9AA0A6" fillOpacity="0.8" />
            <rect x={horizontal ? x + w - 6 : x} y={horizontal ? y : y + h - 6} width={cap.w} height={cap.h} fill="#9AA0A6" fillOpacity="0.8" />
          </g>
        );
      })}

      {/* Button contact pads: D-pad, A and B, Start and Select */}
      <g fill="none" stroke={GOLD} strokeOpacity="0.35" strokeWidth="2.5">
        {pad(240, 800, 34, 'up')}
        {pad(170, 870, 34, 'left')}
        {pad(310, 870, 34, 'right')}
        {pad(240, 940, 34, 'down')}
        {pad(1160, 820, 40, 'b')}
        {pad(1270, 770, 40, 'a')}
        <rect x="560" y="900" width="70" height="30" rx="15" />
        <rect x="680" y="900" width="70" height="30" rx="15" />
      </g>

      {/* Speaker grille */}
      <g fill="#0D1A12">{speakerHoles(1390, 860)}</g>

      {/* Screw bosses */}
      {SCREWS.map(([x, y], i) => (
        <g key={i}>
          <circle cx={x} cy={y} r="30" fill="#1B2E22" stroke="#2F5A3D" strokeWidth="3" />
          <circle cx={x} cy={y} r="17" fill="#767C83" />
          <path d={`M${x - 9} ${y} H${x + 9} M${x} ${y - 9} V${y + 9}`} stroke="#3A3F44" strokeWidth="3.5" strokeLinecap="round" />
        </g>
      ))}

      {/* Silkscreen marks */}
      <g fill="#335A41" fontFamily="Space Mono, monospace" fontSize="14" letterSpacing="2">
        <text x="1060" y="512">U2</text>
        <text x="880" y="700">U1</text>
        <text x="1240" y="760">U3</text>
        <text x="70" y="990" fontSize="12">CGB-CPU-01  MADE IN JAPAN</text>
      </g>
    </svg>
  );
}
