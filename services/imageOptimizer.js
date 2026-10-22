const path = require('path');

let sharp = null;
try {
  sharp = require('sharp');
} catch (e) {
  console.warn('⚠️ [ImageOptimizer] Sharp not installed, will pass through raw images:', e.message);
}

/**
 * High-performance backend image optimizer using Sharp
 * - Automatically rotates images based on EXIF orientation (prevents upside down / sideways photos)
 * - Downscales large camera photos to a max bounding box (default: 1400x1400)
 * - Compresses JPEG using mozjpeg (industry standard quality & compression)
 * - Passes PDFs through untouched
 * 
 * @param {string} base64String Raw base64 string
 * @param {string} filename Original filename
 * @param {object} options Optimization options { maxWidth, maxHeight, quality }
 * @returns {Promise<{ buffer: Buffer, contentType: string, filename: string, sizeBytes: number }|null>}
 */
async function optimizeBase64Image(base64String, filename = 'document.jpg', options = {}) {
  if (!base64String) return null;

  // Strip potential data URL prefix (e.g. data:image/jpeg;base64,...)
  const cleanBase64 = base64String.replace(/^data:[^;]+;base64,/, '');
  const rawBuffer = Buffer.from(cleanBase64, 'base64');
  const lowerName = filename.toLowerCase();

  // If PDF, pass through as PDF
  if (lowerName.endsWith('.pdf')) {
    return {
      buffer: rawBuffer,
      contentType: 'application/pdf',
      filename: filename.endsWith('.pdf') ? filename : `${filename}.pdf`,
      sizeBytes: rawBuffer.length
    };
  }

  // If Sharp is not available, return raw buffer with basic content type
  if (!sharp) {
    const isPng = lowerName.endsWith('.png');
    return {
      buffer: rawBuffer,
      contentType: isPng ? 'image/png' : 'image/jpeg',
      filename,
      sizeBytes: rawBuffer.length
    };
  }

  const maxWidth = options.maxWidth || 1400;
  const maxHeight = options.maxHeight || 1400;
  const quality = options.quality || 80;

  const startTime = Date.now();
  try {
    const pipeline = sharp(rawBuffer)
      .rotate() // Auto-orient based on EXIF tags
      .resize({
        width: maxWidth,
        height: maxHeight,
        fit: 'inside',
        withoutEnlargement: true
      })
      .jpeg({
        quality,
        mozjpeg: true,
        progressive: true
      });

    const optimizedBuffer = await pipeline.toBuffer();
    const duration = Date.now() - startTime;
    const originalKb = (rawBuffer.length / 1024).toFixed(1);
    const optimizedKb = (optimizedBuffer.length / 1024).toFixed(1);
    const savedPercent = (((rawBuffer.length - optimizedBuffer.length) / rawBuffer.length) * 100).toFixed(1);

    console.log(`[ImageOptimizer] ⚡ ${filename}: ${originalKb} KB -> ${optimizedKb} KB (${savedPercent}% saved) in ${duration}ms`);

    const baseName = path.parse(filename).name || 'receipt';
    return {
      buffer: optimizedBuffer,
      contentType: 'image/jpeg',
      filename: `${baseName}.jpg`,
      sizeBytes: optimizedBuffer.length
    };
  } catch (err) {
    console.warn(`[ImageOptimizer] Compression warning on ${filename}, falling back to original:`, err.message);
    return {
      buffer: rawBuffer,
      contentType: 'image/jpeg',
      filename,
      sizeBytes: rawBuffer.length
    };
  }
}

module.exports = {
  optimizeBase64Image
};
