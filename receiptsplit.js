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
