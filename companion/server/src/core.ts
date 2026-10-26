/**
 * Which pack format a card gets, from the cover picker core installed on it.
 *
 * The core lives in Cores/maxsorto.GBC. Its core.json has core.metadata.version.
 * Streaming builds carry a "-coverN" suffix with N of 2 or more, for example
 * "1.4.0-cover2". Those read pack v7 and show every game. Anything else, or no
 * core at all, gets pack v6 with 31 games, which today's core reads.
 */
import fs from 'node:fs';
import path from 'node:path';
import { MAX_GAMES, MAX_GAMES_V7 } from './pack.js';

export const CORE_DIR = path.join('Cores', 'maxsorto.GBC');

export interface CoreInfo {
  /** core.json was found and read. */
  found: boolean;
  version: string | null;
  /** N from "-coverN", or null when there is no such suffix. */
  coverGeneration: number | null;
  error?: string;
}

export interface PackChoice {
  version: 6 | 7;
  /** Most games the pack holds. */
  limit: number;
  core: CoreInfo;
  /** One line for the plan and the Pocket view. */
  reason: string;
  streaming: boolean;
}

export function coverGeneration(version: string): number | null {
  const m = version.match(/-cover(\d+)\b/i);
  return m ? Number(m[1]) : null;
}

export function readCore(card: string): CoreInfo {
  const file = path.join(path.resolve(card), CORE_DIR, 'core.json');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { found: false, version: null, coverGeneration: null };
  }
  try {
    const j = JSON.parse(raw) as { core?: { metadata?: { version?: unknown } } };
    const v = j?.core?.metadata?.version;
    const version = typeof v === 'string' ? v : null;
    return { found: true, version, coverGeneration: version ? coverGeneration(version) : null };
  } catch (e) {
    return { found: true, version: null, coverGeneration: null, error: `core.json could not be read: ${(e as Error).message}` };
  }
}

/** Pick the pack format for a card. `games` is how many the Pocket menu has, for the message. */
export function choosePack(card: string | null, games: number): PackChoice {
  const core: CoreInfo = card ? readCore(card) : { found: false, version: null, coverGeneration: null };
  if (core.coverGeneration != null && core.coverGeneration >= 2) {
    const all = Math.min(games, MAX_GAMES_V7);
    return {
      version: 7,
      limit: MAX_GAMES_V7,
      core,
      streaming: true,
      reason:
        games > MAX_GAMES_V7
          ? `Streaming core found (${core.version}): the first ${MAX_GAMES_V7} of ${games} games. That is the most pack v7 holds.`
          : `Streaming core found (${core.version}): all ${all} games.`,
    };
  }
  const reason = !card
    ? `No card yet. Today's core shows ${MAX_GAMES} games.`
    : !core.found
      ? `No cover picker core found in ${CORE_DIR.split(path.sep).join('/')}. Writing the ${MAX_GAMES} game format today's core reads.`
      : `This core (${core.version ?? 'unknown version'}) shows ${MAX_GAMES} games. Install build 17 to see all.`;
  return { version: 6, limit: MAX_GAMES, core, streaming: false, reason };
}
