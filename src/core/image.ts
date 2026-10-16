import { ConfigError, SchemaError } from "./errors";
import { MAX_IMAGE_DIMENSION, MAX_IMAGE_PIXELS } from "./limits";

export function dimensions(width: unknown, height: unknown): { width: number; height: number } {
  if (typeof width !== "number" || typeof height !== "number" ||
      !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 ||
      width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS) {
    throw new ConfigError("Invalid or excessive image dimensions");
  }
  return { width, height };
}

// Header inspection only: this connector does not decode, render or analyze images.
export function inspectImage(b: Buffer, mime: string): { width: number; height: number; extension: string } {
  const invalid = () => { throw new SchemaError("cdn", "invalid or truncated image"); };
  let w = 0, h = 0, extension = "";
  if (mime === "image/png") {
    if (b.length < 45 || !b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return invalid();
    let pos = 8, ihdr = false, idat = false, end = false;
    while (pos + 12 <= b.length) {
      const n = b.readUInt32BE(pos), kind = b.toString("ascii", pos + 4, pos + 8);
      if (pos + 12 + n > b.length) return invalid();
      if (!ihdr) {
        if (kind !== "IHDR" || n !== 13) return invalid();
        w = b.readUInt32BE(pos + 8); h = b.readUInt32BE(pos + 12); ihdr = true;
      } else if (kind === "IHDR") return invalid();
      if (kind === "acTL") return invalid(); // Animated images are not supported.
      if (kind === "IDAT" && n > 0) idat = true;
      pos += n + 12;
      if (kind === "IEND") { if (n !== 0 || pos !== b.length) return invalid(); end = true; break; }
    }
    if (!end || !idat) return invalid();
    extension = "png";
  } else if (mime === "image/jpeg") {
    if (b.length < 12 || b[0] !== 255 || b[1] !== 216 || b[b.length-2] !== 255 || b[b.length-1] !== 217) return invalid();
    let pos = 2, scan = false;
    while (pos < b.length - 2) {
      if (b[pos++] !== 255) return invalid();
      while (b[pos] === 255) pos++;
      const marker = b[pos++];
      if (marker === undefined || marker === 0 || marker === 216 || marker === 217) return invalid();
      if (pos + 2 > b.length) return invalid();
      const n = b.readUInt16BE(pos);
      if (n < 2 || pos + n > b.length - 2) return invalid();
      if ([192,193,194].includes(marker)) {
        if (n < 8 || w) return invalid();
        h = b.readUInt16BE(pos+3); w = b.readUInt16BE(pos+5);
      }
      if (marker === 218) { scan = true; break; }
      pos += n;
    }
    if (!scan || !w) return invalid();
    extension = "jpg";
  } else if (mime === "image/webp") {
    if (b.length < 30 || b.toString("ascii",0,4) !== "RIFF" || b.toString("ascii",8,12) !== "WEBP" || b.readUInt32LE(4)+8 !== b.length) return invalid();
    let pos = 12, image = false;
    while (pos + 8 <= b.length) {
      const kind = b.toString("ascii",pos,pos+4), n = b.readUInt32LE(pos+4), p = pos+8;
      if (p+n > b.length) return invalid();
      if (kind === "ANIM" || kind === "ANMF") return invalid();
      if (kind === "VP8X") {
        if (n !== 10 || (b[p]! & 2)) return invalid();
        w = 1+b.readUIntLE(p+4,3); h = 1+b.readUIntLE(p+7,3);
      } else if (kind === "VP8 ") {
        if (n < 10 || b[p+3] !== 157 || b[p+4] !== 1 || b[p+5] !== 42) return invalid();
        const iw = b.readUInt16LE(p+6)&16383, ih = b.readUInt16LE(p+8)&16383;
        if (w && (w !== iw || h !== ih)) return invalid();
        w = iw; h = ih; image = true;
      } else if (kind === "VP8L") {
        if (n < 5 || b[p] !== 47) return invalid();
        const bits = b.readUInt32LE(p+1), iw = (bits&16383)+1, ih = ((bits>>>14)&16383)+1;
        if (w && (w !== iw || h !== ih)) return invalid();
        w = iw; h = ih; image = true;
      }
      pos = p+n+(n%2);
    }
    if (pos !== b.length || !image) return invalid();
    extension = "webp";
  } else return invalid();
  return { ...dimensions(w,h), extension };
}
