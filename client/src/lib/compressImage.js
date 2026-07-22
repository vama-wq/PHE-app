// Client-side image compression — applied before every photo upload so raw
// phone-camera shots (~2-8 MB) become ~150-400 KB JPEGs. Keeps PDFs and
// non-images untouched; falls back to the original file on any failure
// (e.g. HEIC on browsers that can't decode it).
export async function compressImage(file, maxDim = 1600, quality = 0.75) {
  if (!file || !file.type?.startsWith('image/') || file.type === 'image/gif') return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
    if (!blob || blob.size >= file.size) return file; // never make it bigger
    return new File([blob.slice(0, blob.size, 'image/jpeg')], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

export async function compressImages(files, maxDim, quality) {
  return Promise.all(Array.from(files || []).map(f => compressImage(f, maxDim, quality)));
}
