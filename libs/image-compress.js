// Client-side image compress + face-center crop helper
// Exposes window.imageCompress.compressWithFaceCrop(...) and loadBlazeFaceModel()
// Requires TensorFlow.js and BlazeFace to be loaded on the page (CDN script tags)

let _blazeModel = null;
async function loadBlazeFaceModel() {
  if (_blazeModel) return _blazeModel;
  if (typeof blazeface === 'undefined') throw new Error('blazeface model not found; include CDN script for @tensorflow-models/blazeface');
  _blazeModel = await blazeface.load();
  return _blazeModel;
}

/**
 * Compress image file, auto-detect face and crop-center on face when possible.
 * @param {File} file - input image file
 * @param {Object} opts - options: { outputSize=256, expand=1.4, mimeType='image/webp', quality=0.7, detectFace=true }
 * @returns {Promise<{blob, dataUrl, size, width, height, crop}>}
 */
async function compressWithFaceCrop(file, opts = {}) {
  const { outputSize = 256, expand = 1.4, mimeType = 'image/webp', quality = 0.7, detectFace = true } = opts;

  const imgBitmap = await createImageBitmap(file);
  const iw = imgBitmap.width, ih = imgBitmap.height;

  // Prepare detection canvas (downscale large images for speed)
  const detectCanvas = document.createElement('canvas');
  const maxDetectDim = 512;
  let scale = 1;
  if (Math.max(iw, ih) > maxDetectDim) {
    scale = maxDetectDim / Math.max(iw, ih);
    detectCanvas.width = Math.round(iw * scale);
    detectCanvas.height = Math.round(ih * scale);
    detectCanvas.getContext('2d').drawImage(imgBitmap, 0, 0, detectCanvas.width, detectCanvas.height);
  } else {
    detectCanvas.width = iw;
    detectCanvas.height = ih;
    detectCanvas.getContext('2d').drawImage(imgBitmap, 0, 0);
  }

  let faceBox = null;
  if (detectFace) {
    try {
      await loadBlazeFaceModel();
      const preds = await _blazeModel.estimateFaces(detectCanvas, false);
      if (preds && preds.length > 0) {
        // pick largest face
        let best = preds[0];
        if (preds.length > 1) {
          let bestArea = 0;
          for (const p of preds) {
            const [x1,y1] = p.topLeft; const [x2,y2] = p.bottomRight;
            const area = (x2-x1)*(y2-y1);
            if (area > bestArea) { best = p; bestArea = area; }
          }
        }
        const [x1,y1] = best.topLeft; const [x2,y2] = best.bottomRight;
        faceBox = { x: x1 / scale, y: y1 / scale, w: (x2 - x1) / scale, h: (y2 - y1) / scale };
      }
    } catch (e) {
      console.warn('face detect failed', e);
      faceBox = null;
    }
  }

  // compute crop
  let crop;
  if (faceBox) {
    const cx = faceBox.x + faceBox.w/2; const cy = faceBox.y + faceBox.h/2;
    let size = Math.max(faceBox.w, faceBox.h) * expand;
    size = Math.min(size, Math.max(iw, ih));
    let sx = Math.round(cx - size/2); let sy = Math.round(cy - size/2);
    if (sx < 0) sx = 0; if (sy < 0) sy = 0; if (sx + size > iw) sx = iw - size; if (sy + size > ih) sy = ih - size;
    crop = { sx: sx, sy: sy, sSize: Math.round(size) };
  } else {
    const minSide = Math.min(iw, ih); const sx = Math.round((iw - minSide)/2); const sy = Math.round((ih - minSide)/2);
    crop = { sx: sx, sy: sy, sSize: minSide };
  }

  // draw to output canvas
  const outCanvas = document.createElement('canvas'); outCanvas.width = outputSize; outCanvas.height = outputSize;
  const octx = outCanvas.getContext('2d');
  octx.drawImage(imgBitmap, crop.sx, crop.sy, crop.sSize, crop.sSize, 0, 0, outputSize, outputSize);

  const blob = await new Promise((res, rej) => {
    outCanvas.toBlob(b => { if (!b) return rej(new Error('toBlob failed')); res(b); }, mimeType, quality);
  });

  const dataUrl = await new Promise((res, rej) => {
    const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob);
  });

  return { blob, dataUrl, size: blob.size, width: outputSize, height: outputSize, crop };
}

// expose
window.imageCompress = { loadBlazeFaceModel, compressWithFaceCrop };
