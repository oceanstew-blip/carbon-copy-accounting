// Cut a photo or PDF page that holds SEVERAL receipts into one image per receipt.
//
// Azure's receipt reader already returns one "document" per receipt it sees, each with an outline
// (boundingRegions). This module turns those outlines into crop boxes. It is a best guess: callers
// must send every cut receipt to review so the captain checks the cut.
import sharp from "sharp";

/**
 * Azure analyzeResult -> normalized boxes (0..1) for each detected receipt.
 * Returns [] when there is only one receipt, or when the outlines are not trustworthy
 * (a receipt that spans pages, a missing outline), so the file is handled as a single receipt.
 */
export function azureRegions(analyzeResult) {
  const docs = analyzeResult?.documents || [];
  if (docs.length < 2) return [];
  const pages = analyzeResult.pages || [];
  const out = [];
  for (const doc of docs) {
    const regs = doc.boundingRegions || [];
    if (regs.length !== 1) return []; // no outline, or one receipt over several pages: do not guess
    const r = regs[0];
    const pg = pages.find((p) => p.pageNumber === r.pageNumber);
    const poly = r.polygon || [];
    if (!pg || !pg.width || !pg.height || poly.length < 8) return [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i + 1 < poly.length; i += 2) {
      x0 = Math.min(x0, poly[i]); x1 = Math.max(x1, poly[i]);
      y0 = Math.min(y0, poly[i + 1]); y1 = Math.max(y1, poly[i + 1]);
    }
    const clamp = (v) => Math.max(0, Math.min(1, v));
    out.push({ page: r.pageNumber, x0: clamp(x0 / pg.width), y0: clamp(y0 / pg.height), x1: clamp(x1 / pg.width), y1: clamp(y1 / pg.height) });
  }
  return out;
}

const area = (r) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
function iou(a, b) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / (area(a) + area(b) - inter);
}

/**
 * Decide whether to cut. regions: from azureRegions. pageCount: number of page images available.
 * hasOriginal: true for a PDF (Azure page numbers = PDF pages); false for photos (only page 1 exists).
 * Returns the regions to cut (reading order), or null to leave the file as one receipt.
 */
export function planCuts(regions, pageCount, hasOriginal) {
  if (!Array.isArray(regions) || regions.length < 2) return null;
  if (!hasOriginal && pageCount !== 1) return null; // several photos were stacked together: coordinates do not map back
  const usable = regions.filter((r) => r.page >= 1 && r.page <= pageCount && area(r) >= 0.04 && (r.x1 - r.x0) >= 0.08 && (r.y1 - r.y0) >= 0.1);
  if (usable.length < 2 || usable.length < regions.length - 1) return null; // too many odd regions: do not trust
  for (let i = 0; i < usable.length; i++) for (let j = i + 1; j < usable.length; j++) {
    if (usable[i].page === usable[j].page && iou(usable[i], usable[j]) > 0.5) return null; // same receipt found twice
  }
  return usable.sort((a, b) => a.page - b.page || a.x0 - b.x0 || a.y0 - b.y0);
}

/** Crop one region (normalized box) out of an image, with a little padding. Returns a JPEG buffer. */
export async function cropRegion(buffer, r, pad = 0.015) {
  const img = sharp(buffer, { failOn: "none" }).rotate(); // same orientation Azure saw
  const meta = await sharp(await img.clone().toBuffer()).metadata();
  const W = meta.width, H = meta.height;
  const left = Math.max(0, Math.floor((r.x0 - pad) * W)), top = Math.max(0, Math.floor((r.y0 - pad) * H));
  const right = Math.min(W, Math.ceil((r.x1 + pad) * W)), bottom = Math.min(H, Math.ceil((r.y1 + pad) * H));
  return img.extract({ left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }).jpeg({ quality: 90 }).toBuffer();
}

// ---------------------------------------------------------------------------------------------------------------
// Fallback: find receipts lying side by side by the empty vertical gaps between their text.
// Azure often reads a taped-together row of receipts as ONE receipt, so we also look at the picture ourselves.
// A "black-hat" filter keeps thin dark marks (text, handwriting) and ignores paper edges and shadows. A column that
// has no text anywhere from top to bottom is a gap; text that crosses a gap (a centred header, a total line) means
// it is not a gap between two receipts. Only photos/scans are examined; a clean white digital page never is.
const GW = 640; // working width

function minMax(src, w, h, k, useMax) {
  const r = k >> 1, tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = useMax ? 0 : 255;
    for (let i = Math.max(0, x - r); i <= Math.min(w - 1, x + r); i++) { const s = src[y * w + i]; if (useMax ? s > v : s < v) v = s; }
    tmp[y * w + x] = v;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = useMax ? 0 : 255;
    for (let j = Math.max(0, y - r); j <= Math.min(h - 1, y + r); j++) { const s = tmp[j * w + x]; if (useMax ? s > v : s < v) v = s; }
    out[y * w + x] = v;
  }
  return out;
}

/** @returns {Promise<{regions:{page:number,x0:number,y0:number,x1:number,y1:number}[], debug:object}>} normalized boxes, or [] */
export async function detectSideBySide(buffer, opts = {}) {
  const minGapFrac = opts.minGapFrac ?? 0.007, minWidthFrac = opts.minWidthFrac ?? 0.1;
  const { data, info } = await sharp(buffer, { failOn: "none" }).rotate().resize({ width: GW }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  let bright = 0; for (let i = 0; i < data.length; i++) if (data[i] >= 253) bright++;
  const brightFrac = bright / data.length;
  if (brightFrac > 0.4 || h < w * 0.5) return { regions: [], debug: { brightFrac, reason: "digital or too wide" } };

  const closed = minMax(minMax(data, w, h, 9, true), w, h, 9, false); // closing = erode(dilate)
  const col = new Float32Array(w), ink = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (closed[i] - data[i] > 22) { ink[i] = 1; col[x]++; }
  }
  const edge = Math.round(w * 0.012);
  const occupied = new Uint8Array(w);
  const need = Math.max(5, Math.round(h * 0.012));
  for (let x = 0; x < w; x++) {
    let s = 0; for (let k = -1; k <= 1; k++) { const xx = x + k; if (xx >= 0 && xx < w) s += col[xx]; }
    occupied[x] = x >= edge && x < w - edge && s / 3 >= need ? 1 : 0;
  }
  // A thin occupied stripe (under 4 px) is a paper edge or a shadow line, not text: treat it as empty.
  for (let x = 0; x < w;) {
    if (!occupied[x]) { x++; continue; }
    let e = x; while (e < w && occupied[e]) e++;
    if (e - x < 4) for (let k = x; k < e; k++) occupied[k] = 0;
    x = e;
  }
  // blocks of occupied columns separated by gaps of at least minGapFrac of the width
  const minGap = Math.max(3, Math.round(w * minGapFrac));
  const segs = [];
  let start = -1, last = -1;
  for (let x = 0; x < w; x++) {
    if (occupied[x]) { if (start < 0) start = x; last = x; }
    else if (start >= 0 && x - last >= minGap) { segs.push([start, last]); start = -1; }
  }
  if (start >= 0) segs.push([start, last]);
  const totalInk = col.reduce((p, q) => p + q, 0);
  const massOf = ([a, b]) => { let m = 0; for (let x = a; x <= b; x++) m += col[x]; return m; };
  // each receipt must be wide enough and hold a fair share of all the text (drops stray slivers)
  const kept = segs.filter((sg) => (sg[1] - sg[0] + 1) >= w * minWidthFrac && massOf(sg) >= totalInk * 0.08);
  const debug = { col: opts.debug ? Array.from(col) : undefined, brightFrac: +brightFrac.toFixed(3), segs: segs.map(([a, b]) => `${Math.round(a / w * 100)}-${Math.round(b / w * 100)}%`) };
  if (kept.length < 2) return { regions: [], debug };

  const regions = kept.map(([x0, x1], i) => {
    let y0 = h, y1 = 0;
    const rowNeed = Math.max(2, Math.round((x1 - x0 + 1) * 0.004));
    for (let y = 0; y < h; y++) { let c = 0; for (let x = x0; x <= x1; x++) c += ink[y * w + x]; if (c >= rowNeed) { if (y < y0) y0 = y; if (y > y1) y1 = y; } }
    const prev = i > 0 ? kept[i - 1][1] : 0, next = i < kept.length - 1 ? kept[i + 1][0] : w;
    const padX = Math.min(w * 0.03, (x0 - prev) / 2, (next - x1) / 2);
    const padY = h * 0.025;
    return { page: 1, x0: Math.max(0, (x0 - padX) / w), x1: Math.min(1, (x1 + padX) / w), y0: Math.max(0, (y0 - padY) / h), y1: Math.min(1, (y1 + padY) / h) };
  }).filter((r) => r.y1 - r.y0 > 0.2);
  return { regions: regions.length >= 2 ? regions : [], debug };
}
