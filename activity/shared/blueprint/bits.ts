/**
 * Bit-level reader for Blueprint (`b1@…`) codes.
 *
 * A blueprint code is a base64 payload read as one continuous MSB-first bit
 * stream. Codes are small (a few hundred bits), so the stream is expanded into
 * one bit per array slot up front — it costs nothing at this size and keeps
 * every read a plain slice of the array instead of a shift/mask dance.
 */

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const BASE64_VALUES: ReadonlyMap<string, number> = new Map(
  Array.from(BASE64_ALPHABET, (char, index) => [char, index] as const),
);

const BITS_PER_CHAR = 6;
/** Each padding unit removes two bits from the tail of the final character. */
const BITS_PER_PADDING = 2;

export class EndOfStreamError extends Error {
  constructor(wanted: number, available: number) {
    super(`Bit stream ended: wanted ${wanted} bits, ${available} remain`);
    this.name = "EndOfStreamError";
  }
}

export class InvalidBase64Error extends Error {
  constructor(detail: string) {
    super(`Malformed base64 payload: ${detail}`);
    this.name = "InvalidBase64Error";
  }
}

/**
 * Blueprint codes are written without `=` padding, so a trailing partial
 * character is inferred from the payload length instead.
 */
function countPadding(payload: string): number {
  switch (payload.length % 4) {
    case 0: {
      const explicit = /=*$/.exec(payload)?.[0].length ?? 0;
      if (explicit > 2) throw new InvalidBase64Error("more than two '=' chars");
      return explicit;
    }
    case 2:
      return 2;
    case 3:
      return 1;
    default:
      throw new InvalidBase64Error(`length ${payload.length} % 4 === 1`);
  }
}

export function bitsFromBase64(payload: string): Uint8Array {
  const padding = countPadding(payload);
  const chars = payload.slice(0, payload.length - (payload.endsWith("=") ? padding : 0));
  const totalBits = chars.length * BITS_PER_CHAR - padding * BITS_PER_PADDING;
  const bits = new Uint8Array(Math.max(totalBits, 0));

  let cursor = 0;
  for (const char of chars) {
    const value = BASE64_VALUES.get(char);
    if (value === undefined) throw new InvalidBase64Error(`illegal char '${char}'`);
    for (let shift = BITS_PER_CHAR - 1; shift >= 0 && cursor < bits.length; shift--) {
      bits[cursor++] = (value >> shift) & 1;
    }
  }
  return bits;
}

export class BitReader {
  private cursor = 0;

  constructor(private readonly bits: Uint8Array) {}

  get remaining(): number {
    return this.bits.length - this.cursor;
  }

  read(count = 1): number {
    if (count > this.remaining) throw new EndOfStreamError(count, this.remaining);
    let acc = 0;
    for (let i = 0; i < count; i++) {
      // Multiply rather than shift: opcodes are small but PRNG seeds are a full
      // 32 bits, where `<<` would sign-flip the result.
      acc = acc * 2 + this.bits[this.cursor++]!;
    }
    return acc;
  }

  /** Reads `count` bits, or returns `fallback` if the stream is exhausted. */
  readOr(count: number, fallback: number): number {
    return count <= this.remaining ? this.read(count) : fallback;
  }

  /**
   * Blueprint's variable-width integer: a 1 bit introduces each little-endian
   * nibble, a 0 bit terminates.
   */
  readVarint(): number {
    let acc = 0;
    let shift = 0;
    while (this.read() === 1) {
      acc += this.read(4) * 2 ** shift;
      shift += 4;
    }
    return acc;
  }
}

/**
 * The writer side of the same stream.
 *
 * Bits are collected one per slot and packed at the end, mirroring
 * {@link bitsFromBase64}: at a few hundred bits the array costs nothing and it
 * keeps every write the obvious loop rather than a shift/mask dance.
 */
export class BitWriter {
  private readonly bits: number[] = [];

  write(value: number, count = 1): void {
    for (let shift = count - 1; shift >= 0; shift--) {
      // Divide rather than shift, for the same reason `read` multiplies: a
      // 32-bit value would sign-flip through `>>`.
      this.bits.push(Math.floor(value / 2 ** shift) % 2);
    }
  }

  /** The inverse of {@link BitReader.readVarint}: 1-bit-led little-endian nibbles. */
  writeVarint(value: number): void {
    let rest = value;
    while (rest > 0) {
      this.write(1);
      this.write(rest % 16, 4);
      rest = Math.floor(rest / 16);
    }
    this.write(0);
  }

  /**
   * Base64 with no `=`, which is how blueprint writes it.
   *
   * Padded out to whole four-character groups. The reader infers a partial
   * final character from the payload length and rejects `length % 4 === 1`
   * outright, which a bit stream of the wrong size lands on about a third of
   * the time — so the stream is filled with zero bits to a multiple of 24,
   * where the length says "nothing was dropped" and every written bit survives.
   *
   * Safe because decoding stops at the End opcode: the zeroes are past it and
   * are never read as instructions.
   */
  toBase64(): string {
    const GROUP_BITS = BITS_PER_CHAR * 4;
    while (this.bits.length % GROUP_BITS !== 0) this.bits.push(0);
    let out = "";
    for (let i = 0; i < this.bits.length; i += BITS_PER_CHAR) {
      let value = 0;
      for (let j = 0; j < BITS_PER_CHAR; j++) value = value * 2 + (this.bits[i + j] ?? 0);
      out += BASE64_ALPHABET[value];
    }
    return out;
  }
}
