// 24-unit stroke icons drawn in currentColor, shared by every extension page. Decorative: the control's text names it.

const PATHS = {
  download: ["M12 4v11", "M7 11l5 5 5-5", "M5 20h14"],
  folder: ["M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"],
  "check-circle": ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z", "M8 12.5l3 3 5-6"],
  alert: ["M12 3.5l10 17.5H2z", "M12 10v5", "M12 18h.01"],
  "alert-circle": ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z", "M12 7v6", "M12 16.5h.01"],
  info: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z", "M12 11v6", "M12 7.5h.01"],
  lock: [
    "M7 11h10a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2z",
    "M8 11V8a4 4 0 0 1 8 0v3",
  ],
  globe: [
    "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z",
    "M3 12h18",
    "M12 3c3 3 3 15 0 18",
    "M12 3c-3 3-3 15 0 18",
  ],
  tab: ["M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z", "M3 9h18"],
  clock: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z", "M12 7v5l3 2"],
  layers: ["M12 3l9 5-9 5-9-5z", "M3 13l9 5 9-5"],
  sliders: [
    "M4 7h10",
    "M18 7h2",
    "M4 17h2",
    "M10 17h10",
    "M18 7a2 2 0 1 1-4 0 2 2 0 0 1 4 0z",
    "M10 17a2 2 0 1 1-4 0 2 2 0 0 1 4 0z",
  ],
  "chevron-left": ["M15 6l-6 6 6 6"],
  copy: [
    "M11 9h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z",
    "M5 15H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1",
  ],
  code: ["M8 7l-5 5 5 5", "M16 7l5 5-5 5"],
  database: [
    "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z",
    "M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6",
    "M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6",
  ],
  incognito: [
    "M3 11h18",
    "M5 11l1.5-6h11L19 11",
    "M10.5 16.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z",
    "M18.5 16.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z",
    "M10.5 16h3",
  ],
  refresh: ["M20 12a8 8 0 1 1-2.5-5.8", "M20 4v5h-5"],
  plug: ["M9 3v5", "M15 3v5", "M6 8h12v3a6 6 0 0 1-12 0z", "M12 17v4"],
  history: ["M3 12a9 9 0 1 0 3-6.7", "M3 4v5h5", "M12 7v5l3 2"],
  x: ["M6 6l12 12", "M18 6L6 18"],
  plus: ["M12 5v14", "M5 12h14"],
  trash: ["M4 7h16", "M9 7V4h6v3", "M6 7l1 13h10l1-13"],
  play: ["M8 5v14l11-7z"],
} as const;

export type IconName = keyof typeof PATHS;

export const Icon = ({ name, size = 16 }: { readonly name: IconName; readonly size?: number }) => (
  <svg
    className="ic"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {PATHS[name].map((d) => (
      <path key={d} d={d} />
    ))}
  </svg>
);
