// Offline source for `?demo=1`: a synthetic osu!standard play that feeds the same code paths as
// vosu (precise payload text and v2 meta values), so the overlay can be developed and screenshotted
// without a server.

const CS = 4.2;
const OD = 8.5;
const RADIUS = 54.4 - 4.48 * CS;
const WINDOWS = { great: 80 - 6 * OD, ok: 140 - 8 * OD, meh: 200 - 10 * OD };
const SEEDED_HITS = 320;
const HITS_PER_ATTEMPT = 900;
const FRAME_MS = 40;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A player with a slight down-right aim bias, overshoot along jump direction, and early taps. */
class SyntheticPlayer {
  constructor(seed) {
    this.random = mulberry32(seed);
    this.angle = 0;
  }

  gaussian() {
    const u = 1 - this.random();
    const v = this.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  hit() {
    if (this.random() < 0.3) this.angle = this.random() * 2 * Math.PI;
    const overshoot = 3 + 5 * this.gaussian();
    for (;;) {
      const x = 2.5 + 0.3 * RADIUS * this.gaussian() + Math.cos(this.angle) * overshoot;
      const y = 1.5 + 0.3 * RADIUS * this.gaussian() + Math.sin(this.angle) * overshoot;
      if (Math.hypot(x, y) > RADIUS) continue;
      const spread = this.random() < 0.06 ? 32 : 11;
      const error = Math.max(-WINDOWS.meh, Math.min(WINDOWS.meh, -4 + spread * this.gaussian()));
      return [x, y, error].map((value) => Math.round(value * 100) / 100);
    }
  }

  /** Seconds until the next hit: streams, jumps and short breaks. */
  gap() {
    const roll = this.random();
    if (roll < 0.55) return 0.09 + 0.02 * this.random();
    if (roll < 0.95) return 0.18 + 0.12 * this.random();
    return 0.6 + 0.8 * this.random();
  }
}

/**
 * @param {number} seed
 * @param {(meta: {state: number, mode: number, cs: number, hitWindow: object, rate: number, checksum: string}) => void} onMeta
 * @param {(payload: string) => void} onPrecise precise payload text, as vosu sends it filtered
 */
export function startDemo(seed, onMeta, onPrecise) {
  const player = new SyntheticPlayer(seed);
  onMeta({ state: 2, mode: 0, cs: CS, hitWindow: WINDOWS, rate: 1, checksum: `demo-${seed}` });

  // The first frame already holds SEEDED_HITS hits, like opening the overlay mid-play; a full
  // attempt then restarts from an empty array, like a retry.
  let body = "";
  let hits = 0;
  const add = () => {
    const triple = player.hit().join(",");
    body = hits === 0 ? triple : `${body},${triple}`;
    hits++;
  };
  for (let i = 0; i < SEEDED_HITS; i++) add();
  onPrecise(`{"hitOffsets":[${body}]}`);

  let due = performance.now() + player.gap() * 1000;
  setInterval(() => {
    const now = performance.now();
    while (now >= due) {
      if (hits >= HITS_PER_ATTEMPT) {
        body = "";
        hits = 0;
      }
      add();
      due += player.gap() * 1000;
    }
    onPrecise(`{"hitOffsets":[${body}]}`);
  }, FRAME_MS);
}
