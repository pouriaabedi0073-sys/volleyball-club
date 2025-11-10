const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

// Files to optimize (relative to repo root)
const iconsDir = path.join(__dirname, '..', 'icons');
const targets = [
  'volleyball-player (3).png',
  'volleyball-player (4).png',
  'volleyball (1).png'
];

async function optimize(file) {
  const src = path.join(iconsDir, file);
  if (!fs.existsSync(src)) {
    console.warn('missing:', src);
    return;
  }
  const outName = file.replace(/\.(png|jpg|jpeg)$/i, '') + '-opt.webp';
  const out = path.join(iconsDir, outName);
  try {
    const img = sharp(src);
    const meta = await img.metadata();
    const max = 800; // if larger than this, we'll downscale
    const width = meta.width || max;
    const height = meta.height || max;
    const scale = Math.min(1, max / Math.max(width, height));
    const resizeOpts = scale < 1 ? { width: Math.round(width * scale), height: Math.round(height * scale) } : {};
    await img
      .resize(resizeOpts)
      .webp({ quality: 80 })
      .toFile(out);
    const inSize = fs.statSync(src).size;
    const outSize = fs.statSync(out).size;
    console.log(`${file} -> ${outName}  (in: ${Math.round(inSize/1024)}KB, out: ${Math.round(outSize/1024)}KB)`);
  } catch (e) {
    console.error('optimize failed for', file, e);
  }
}

(async () => {
  for (const t of targets) await optimize(t);
  console.log('done. To overwrite originals use the --replace flag (manual step).');
})();
