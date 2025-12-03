/**
 * Angle Detection Service
 * Uses Tesseract OSD (via backend) to detect image rotation and apply corrections.
 */

export interface AngleDetectionResult {
  angle: number;
  confidence: number;
  method: 'tesseract' | 'manual' | 'dimension-heuristic';
}

const API_BASE = "http://localhost:5000";

/**
 * Detect the rotation angle of text in an image using Tesseract OSD.
 * Returns the correction angle needed (0, 90, 180, or 270 degrees).
 */
export async function detectRotationAngle(
  imageData: string,
  onProgress?: (progress: number, status: string) => void
): Promise<AngleDetectionResult> {
  try {
    onProgress?.(10, 'Sending image for rotation detection...');

    const response = await fetch(`${API_BASE}/detect-rotation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        image: imageData,
      }),
    });

    if (!response.ok) {
      throw new Error(`Server error: ${response.status}`);
    }

    const result = await response.json();
    onProgress?.(70, `OSD result: orientation=${result.orientation}°, confidence=${result.confidence}`);

    if (result.success && result.orientation !== undefined) {
      const orientation = result.orientation;
      // Tesseract OSD confidence is on 0-15 scale, normalize to 0-1
      const confidence = Math.min(result.confidence / 15, 1.0);

      // Tesseract reports current orientation, we need to apply correction
      // "Orientation in degrees: 90" means image is rotated 90° clockwise
      // We need to rotate 270° to correct it (90° counter-clockwise)
      let correctionAngle = 0;
      if (orientation === 90) {
        correctionAngle = 270;  // Rotate 270° CW = 90° CCW to correct
      } else if (orientation === 180) {
        correctionAngle = 180;  // Rotate 180° to correct
      } else if (orientation === 270) {
        correctionAngle = 90;   // Rotate 90° CW to correct
      }

      onProgress?.(100, correctionAngle !== 0
        ? `Correction needed: rotate ${correctionAngle}°`
        : 'No rotation correction needed');

      return {
        angle: correctionAngle,
        confidence: confidence,
        method: 'tesseract',
      };
    }

    // Fallback if no orientation data
    onProgress?.(100, 'No orientation data detected');
    return {
      angle: 0,
      confidence: 0.3,
      method: 'dimension-heuristic',
    };

  } catch (error) {
    console.error('Angle detection failed:', error);
    const errorMsg = error instanceof Error ? error.message : String(error);
    onProgress?.(100, `Detection failed: ${errorMsg}`);

    return {
      angle: 0,
      confidence: 0,
      method: 'manual',
    };
  }
}

/**
 * Apply rotation to an image and return the rotated base64 data.
 */
export async function rotateImage(imageData: string, angle: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();

    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      if (!ctx) {
        reject(new Error('Failed to get canvas context'));
        return;
      }

      // Canvas rotate() is counter-clockwise positive
      // We want clockwise rotation, so negate the angle
      const radians = (-angle * Math.PI) / 180;
      const sin = Math.abs(Math.sin(radians));
      const cos = Math.abs(Math.cos(radians));

      const newWidth = img.width * cos + img.height * sin;
      const newHeight = img.width * sin + img.height * cos;

      canvas.width = newWidth;
      canvas.height = newHeight;

      // Rotate around center (clockwise)
      ctx.translate(newWidth / 2, newHeight / 2);
      ctx.rotate(radians);
      ctx.drawImage(img, -img.width / 2, -img.height / 2);

      // Return rotated image as base64
      resolve(canvas.toDataURL('image/png'));
    };

    img.onerror = () => {
      reject(new Error('Failed to load image for rotation'));
    };

    img.src = imageData;
  });
}
