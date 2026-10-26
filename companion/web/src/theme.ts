// Theme and GBC colorway, stored on <html> as data-theme and data-shell.

export type ThemeName = 'dmg' | 'gbc';
export type Colorway = 'atomic' | 'teal' | 'berry' | 'kiwi' | 'dandelion' | 'grape';

export const COLORWAYS: { id: Colorway; label: string; swatch: string }[] = [
  { id: 'atomic', label: 'Atomic Purple', swatch: '#5E4F86' },
  { id: 'teal', label: 'Teal', swatch: '#1F8C93' },
  { id: 'berry', label: 'Berry', swatch: '#C2185B' },
  { id: 'kiwi', label: 'Kiwi', swatch: '#9BBF2A' },
  { id: 'dandelion', label: 'Dandelion', swatch: '#F2C230' },
  { id: 'grape', label: 'Grape', swatch: '#5B2A86' },
];

export interface ThemeState {
  theme: ThemeName;
  shell: Colorway;
}

const KEY = 'theme';

export function readTheme(): ThemeState {
  const fallback: ThemeState = { theme: 'dmg', shell: 'atomic' };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    const theme = raw?.theme === 'gbc' ? 'gbc' : 'dmg';
    const shell = COLORWAYS.some((c) => c.id === raw?.shell) ? (raw.shell as Colorway) : 'atomic';
    return { theme, shell };
  } catch {
    return fallback;
  }
}

export function applyTheme(t: ThemeState): void {
  document.documentElement.dataset.theme = t.theme;
  document.documentElement.dataset.shell = t.shell;
  try {
    localStorage.setItem(KEY, JSON.stringify(t));
  } catch {
    // storage blocked; the choice still applies for this session
  }
}
