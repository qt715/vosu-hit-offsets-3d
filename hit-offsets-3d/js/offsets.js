import { reconnectDelay, socketUrl } from "./vosu.js";

const INITIAL_CAPACITY = 1024;
// Arrival time for hits that happened before this overlay saw them: far past any fade.
const HISTORICAL = -1e5;

/**
 * The current play's `hitOffsets`, kept exactly as vosu sends them (stride 3: x, y, error) in a
 * Float32Array the renderers upload as-is, plus one arrival time per hit for the age fade.
 */
export class OffsetStore {
  constructor() {
    this.offsets = new Float32Array(INITIAL_CAPACITY * 3);
    this.times = new Float32Array(INITIAL_CAPACITY);
    this.capacity = INITIAL_CAPACITY;
    this.count = 0;
    // Bumped on every reset; renderers re-upload from scratch when it changes.
    this.revision = 0;
    this.epoch = performance.now();
    this.lastHitAt = HISTORICAL;
    this.errorSum = 0;
  }

  /** Seconds since the current play started being tracked (small enough for f32 precision). */
  now() {
    return (performance.now() - this.epoch) / 1000;
  }

  reset() {
    this.count = 0;
    this.revision++;
    this.epoch = performance.now();
    this.lastHitAt = HISTORICAL;
    this.errorSum = 0;
  }

  /** Appends hits `from` (inclusive) to `to` (exclusive) of a flat stride-3 array. */
  append(values, from, to, historical) {
    const added = to - from;
    if (added <= 0) return;
    if (this.count + added > this.capacity) {
      let capacity = this.capacity * 2;
      while (capacity < this.count + added) capacity *= 2;
      const offsets = new Float32Array(capacity * 3);
      offsets.set(this.offsets.subarray(0, this.count * 3));
      const times = new Float32Array(capacity);
      times.set(this.times.subarray(0, this.count));
      this.offsets = offsets;
      this.times = times;
      this.capacity = capacity;
    }
    const time = historical ? HISTORICAL : this.now();
    let o = this.count * 3;
    for (let i = from * 3, end = to * 3; i < end; i += 3) {
      this.offsets[o++] = values[i];
      this.offsets[o++] = values[i + 1];
      this.offsets[o++] = values[i + 2];
      this.errorSum += values[i + 2];
    }
    this.times.fill(time, this.count, this.count + added);
    this.count += added;
    if (!historical) this.lastHitAt = time;
  }

  /** Replaces the play with a full `hitOffsets` array, appending only what is new. */
  sync(values, historical) {
    const total = Math.floor(values.length / 3);
    const last = this.count - 1;
    // A shorter array, or a different last hit, means a new attempt (retry or another map).
    if (
      total < this.count ||
      (last >= 0 &&
        (Math.fround(values[last * 3]) !== this.offsets[last * 3] ||
          Math.fround(values[last * 3 + 1]) !== this.offsets[last * 3 + 1] ||
          Math.fround(values[last * 3 + 2]) !== this.offsets[last * 3 + 2]))
    ) {
      this.reset();
    }
    this.append(values, this.count, total, historical);
  }
}

const PREFIX = '{"hitOffsets":[';
const EMPTY = '{"hitOffsets":[]}';
const COMMA = 44;

/**
 * Turns precise payloads into store updates. vosu resends the whole array at the precise poll
 * rate (every 10 ms by default), so with the `hitOffsets` filter applied an unchanged frame is
 * skipped by string comparison and a grown one is parsed only past the previous frame's end.
 */
export class HitOffsetDecoder {
  constructor(store) {
    this.store = store;
    this.last = null;
    this.historical = true;
    // null until a payload arrives; false when the server does not send `hitOffsets`.
    this.supported = null;
  }

  /** The next frame rebuilds from the full array; `historical` hits are shown already faded. */
  invalidate(historical) {
    this.last = null;
    this.historical = historical;
  }

  /** Returns whether the store or `supported` changed. */
  push(text) {
    if (text === this.last) return false;
    const prev = this.last;
    if (
      prev !== null &&
      prev !== EMPTY &&
      prev.startsWith(PREFIX) &&
      text.length > prev.length &&
      text.charCodeAt(prev.length - 2) === COMMA &&
      text.endsWith("]}") &&
      text.startsWith(prev.substring(0, prev.length - 2))
    ) {
      let tail = null;
      try {
        tail = JSON.parse(`[${text.slice(prev.length - 1, -2)}]`);
      } catch {}
      if (Array.isArray(tail) && tail.length % 3 === 0) {
        this.store.append(tail, 0, tail.length / 3, false);
        this.last = text;
        return true;
      }
    }

    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return false;
    }
    const values = message?.hitOffsets;
    const supported = Array.isArray(values);
    const flipped = supported !== this.supported;
    this.supported = supported;
    if (!supported) return flipped;
    const { revision, count } = this.store;
    this.store.sync(values, this.historical);
    this.historical = false;
    this.last = text;
    return flipped || this.store.revision !== revision || this.store.count !== count;
  }
}

/** `/websocket/v2/precise`, filtered down to `hitOffsets`, reconnecting with backoff. */
export class PreciseOffsetStream {
  constructor(decoder, onChange) {
    this.decoder = decoder;
    this.onChange = onChange;
    this.attempt = 0;
    this.connect();
  }

  connect() {
    const socket = new WebSocket(socketUrl("/websocket/v2/precise"));
    socket.onopen = () => {
      this.attempt = 0;
      this.decoder.invalidate(true);
      socket.send('applyFilters:["hitOffsets"]');
    };
    socket.onmessage = (event) => {
      if (typeof event.data === "string" && this.decoder.push(event.data)) this.onChange();
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => setTimeout(() => this.connect(), reconnectDelay(this.attempt++));
  }
}
