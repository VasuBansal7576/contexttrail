/** Procedural rights-cleared test/evaluation pixels. No external assets. Not runtime input. */
import { PNG } from 'pngjs';

export function syntheticPng(seed: number, width = 320, height = 240): Buffer {
  let state = seed >>> 0;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
  const colors = Array.from({ length: 24 }, () => [random() * 255, random() * 255, random() * 255]);
  const shapes = Array.from({ length: 18 }, () => ({ x: random() * width, y: random() * height, r: 10 + random() * 70, color: Math.floor(random() * colors.length) }));
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const base = colors[(Math.floor(x / 40) + Math.floor(y / 40) * 7) % colors.length];
    let color = base;
    for (const shape of shapes) if ((x - shape.x) ** 2 + (y - shape.y) ** 2 < shape.r ** 2) color = colors[shape.color];
    const texture = 12 * Math.sin(x * 0.17 + seed) * Math.cos(y * 0.13 + seed / 7);
    const i = (y * width + x) * 4;
    for (let c = 0; c < 3; c++) png.data[i + c] = Math.max(0, Math.min(255, color[c] + texture));
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}
export function transformPng(bytes: Buffer, transform: { crop?: { x: number; y: number; width: number; height: number }; overlay?: boolean; brightness?: number; mirror?: boolean }): Buffer {
  const source = PNG.sync.read(bytes), crop = transform.crop ?? { x: 0, y: 0, width: source.width, height: source.height };
  const output = new PNG({ width: crop.width, height: crop.height });
  for (let y = 0; y < output.height; y++) for (let x = 0; x < output.width; x++) {
    const i = (y * output.width + x) * 4, sx = transform.mirror ? crop.x + crop.width - x - 1 : crop.x + x, j = ((crop.y + y) * source.width + sx) * 4;
    for (let c = 0; c < 3; c++) output.data[i + c] = Math.max(0, Math.min(255, source.data[j + c] + (transform.brightness ?? 0)));
    output.data[i + 3] = 255;
    // Synthetic subtitle strip with separated light glyph-like bars. No text recognition.
    if (transform.overlay && y >= output.height * 0.8) {
      const light = y > output.height * 0.84 && y < output.height * 0.93 && x % 17 < 10 && x > output.width * 0.1 && x < output.width * 0.9;
      output.data[i] = output.data[i + 1] = output.data[i + 2] = light ? 240 : 8;
    }
  }
  return PNG.sync.write(output);
}
