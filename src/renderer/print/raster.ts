let fontDataUrl: Promise<string> | undefined;

/** The bundled music font as a `data:` URL, fetched once; standalone SVG and PNG pages embed it. */
export function musicFontDataUrl(): Promise<string> {
  fontDataUrl ??= (async () => {
    const response = await fetch(new URL('/font/Bravura.woff2', location.href));
    if (!response.ok) throw new TypeError(`Music font unavailable (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return `data:font/woff2;base64,${btoa(binary)}`;
  })();
  return fontDataUrl;
}

const loadImage = (url: string): Promise<HTMLImageElement> => new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new TypeError('Page SVG could not be decoded'));
  image.src = url;
});

export type RasterInput = { readonly svg: string; readonly width: number; readonly height: number; readonly dpi: number };

/** Rasterizes one page SVG (CSS px geometry) to PNG at `dpi`; a transparent page keeps its alpha. */
export async function rasterizePage(input: RasterInput): Promise<Uint8Array> {
  const scale = input.dpi / 96;
  const url = URL.createObjectURL(new Blob([input.svg], { type: 'image/svg+xml' }));
  try {
    const image = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(input.width * scale);
    canvas.height = Math.round(input.height * scale);
    const context = canvas.getContext('2d');
    if (!context) throw new TypeError('Canvas 2D context unavailable');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new TypeError('PNG encoding failed');
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}
