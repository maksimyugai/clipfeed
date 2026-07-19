export interface RgbaImage {
  width: number;
  height: number;
  pixels: Uint8Array<ArrayBuffer>;
}

// Icons are authored once on a 16x16 grid and scaled by an integer factor
// (128/32/48/16 are all multiples of 16), so the monogram stays crisp at
// every required size instead of being resampled.
const GRID = 16;
const CORNER_RADIUS = 4;

const GRADIENT_START: [number, number, number] = [0x7f, 0x77, 0xdd]; // #7F77DD
const GRADIENT_END: [number, number, number] = [0xd4, 0x53, 0x7e]; // #D4537E

// "cf" monogram, each letter built from a few rectangles rather than a
// per-pixel bitmap font. Coordinates are grid cells, [x0, y0, x1, y1) half-open.
const MONOGRAM_RECTS: ReadonlyArray<[number, number, number, number]> = [
  // C
  [2, 4, 7, 6],
  [2, 10, 7, 12],
  [2, 4, 4, 12],
  // F
  [9, 4, 11, 12],
  [9, 4, 14, 6],
  [9, 7, 13, 9],
];

export function isInsideRoundedSquare(x: number, y: number): boolean {
  const r = CORNER_RADIUS;
  const inLeft = x < r;
  const inRight = x >= GRID - r;
  const inTop = y < r;
  const inBottom = y >= GRID - r;

  if ((inLeft || inRight) && (inTop || inBottom)) {
    const cx = inLeft ? r - 0.5 : GRID - r - 0.5;
    const cy = inTop ? r - 0.5 : GRID - r - 0.5;
    const dx = x + 0.5 - cx;
    const dy = y + 0.5 - cy;
    return dx * dx + dy * dy <= r * r;
  }
  return true;
}

export function isMonogramPixel(x: number, y: number): boolean {
  return MONOGRAM_RECTS.some(([x0, y0, x1, y1]) => x >= x0 && x < x1 && y >= y0 && y < y1);
}

export function gradientColor(x: number, y: number): [number, number, number] {
  const t = (x + y) / (2 * (GRID - 1));
  return [
    Math.round(GRADIENT_START[0] + (GRADIENT_END[0] - GRADIENT_START[0]) * t),
    Math.round(GRADIENT_START[1] + (GRADIENT_END[1] - GRADIENT_START[1]) * t),
    Math.round(GRADIENT_START[2] + (GRADIENT_END[2] - GRADIENT_START[2]) * t),
  ];
}

// Renders a gradient rounded-square "cf" monogram at `size` x `size`
// (`size` must be a multiple of 16 — true for all four required icon sizes).
export function renderIconImage(size: number): RgbaImage {
  if (size % GRID !== 0) {
    throw new Error(`icon size ${size} must be a multiple of ${GRID}`);
  }
  const scale = size / GRID;
  const pixels = new Uint8Array(new ArrayBuffer(size * size * 4));

  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      const inside = isInsideRoundedSquare(gx, gy);
      let r = 0, g = 0, b = 0, a = 0;
      if (inside) {
        a = 255;
        if (isMonogramPixel(gx, gy)) {
          r = g = b = 255;
        } else {
          [r, g, b] = gradientColor(gx, gy);
        }
      }
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const px = gx * scale + sx;
          const py = gy * scale + sy;
          const offset = (py * size + px) * 4;
          pixels[offset] = r;
          pixels[offset + 1] = g;
          pixels[offset + 2] = b;
          pixels[offset + 3] = a;
        }
      }
    }
  }

  return { width: size, height: size, pixels };
}
