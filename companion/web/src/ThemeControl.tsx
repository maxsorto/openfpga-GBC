import { useState } from 'react';
import { COLORWAYS, applyTheme, readTheme, type ThemeState } from './theme';

/** DMG or GBC, plus the GBC shell colorway. */
export function ThemeControl() {
  const [t, setT] = useState<ThemeState>(readTheme);
  const set = (next: ThemeState) => {
    setT(next);
    applyTheme(next);
  };
  return (
    <div className="theme-control">
      <div className="theme-pill" role="radiogroup" aria-label="Theme">
        {(['dmg', 'gbc'] as const).map((name) => (
          <button
            key={name}
            role="radio"
            aria-checked={t.theme === name}
            className={t.theme === name ? 'on' : ''}
            onClick={() => set({ ...t, theme: name })}
          >
            {name}
          </button>
        ))}
      </div>
      {t.theme === 'gbc' && (
        <div className="swatches" role="radiogroup" aria-label="Shell color">
          {COLORWAYS.map((c) => (
            <button
              key={c.id}
              role="radio"
              aria-checked={t.shell === c.id}
              aria-label={c.label}
              title={c.label}
              className={`swatch ${t.shell === c.id ? 'on' : ''}`}
              style={{ background: c.swatch }}
              onClick={() => set({ ...t, shell: c.id })}
            />
          ))}
        </div>
      )}
    </div>
  );
}
