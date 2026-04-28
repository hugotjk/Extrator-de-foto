import * as pdfjsLib from 'pdfjs-dist';
// @ts-ignore
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';

// Set worker source to local file via Vite
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

export async function getPdfDocument(file: File) {
  const arrayBuffer = await file.arrayBuffer();
  return pdfjsLib.getDocument({ data: arrayBuffer }).promise;
}

export async function getPageImage(pdf: any, pageNum: number, scale: number = 1.5): Promise<string> {
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  
  if (!context) throw new Error('Could not get canvas context');
  
  canvas.height = viewport.height;
  canvas.width = viewport.width;

  await page.render({
    canvasContext: context,
    viewport: viewport,
    // @ts-ignore
    canvas: canvas
  }).promise;

  const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
  
  // Clean up canvas
  canvas.width = 0;
  canvas.height = 0;
  
  return dataUrl;
}

export async function cropImage(base64Image: string, box: [number, number, number, number], quality: number = 0.8): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Could not get canvas context'));
        return;
      }

      const [ymin, xmin, ymax, xmax] = box;
      
      // Box is normalized 0-1000
      const x = (xmin / 1000) * img.width;
      const y = (ymin / 1000) * img.height;
      const width = ((xmax - xmin) / 1000) * img.width;
      const height = ((ymax - ymin) / 1000) * img.height;

      canvas.width = width;
      canvas.height = height;

      ctx.drawImage(img, x, y, width, height, 0, 0, width, height);
      
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Canvas toBlob failed'));
      }, 'image/jpeg', quality);
    };
    img.onerror = reject;
    img.src = base64Image;
  });
}
