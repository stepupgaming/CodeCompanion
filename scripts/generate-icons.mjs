import { readFile, writeFile } from 'node:fs/promises';
import { Resvg } from '@resvg/resvg-js';

const source = await readFile(new URL('../assets/logo-icon.svg', import.meta.url));
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const images = new Map(
  sizes.map((size) => [size, new Resvg(source, { fitTo: { mode: 'width', value: size } }).render().asPng()]),
);
const save = (name, bytes) => writeFile(new URL(`../build/${name}`, import.meta.url), bytes);

// ICO directory entries point to independently rasterized PNGs, including small taskbar sizes.
const windowsSizes = sizes.filter((size) => size <= 256);
const directory = Buffer.alloc(6 + windowsSizes.length * 16);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(windowsSizes.length, 4);
let offset = directory.length;
for (const [index, size] of windowsSizes.entries()) {
  const entry = 6 + index * 16;
  const png = images.get(size);
  directory[entry] = directory[entry + 1] = size === 256 ? 0 : size;
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(png.length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += png.length;
}
await save('icon.ico', Buffer.concat([directory, ...windowsSizes.map((size) => images.get(size))]));

// Modern ICNS PNG representations, including Retina sizes.
const types = [
  [16, 'icp4'],
  [32, 'icp5'],
  [64, 'icp6'],
  [128, 'ic07'],
  [256, 'ic08'],
  [512, 'ic09'],
  [1024, 'ic10'],
];
const chunks = types.map(([size, type]) => {
  const png = images.get(size);
  const header = Buffer.alloc(8);
  header.write(type);
  header.writeUInt32BE(8 + png.length, 4);
  return Buffer.concat([header, png]);
});
const header = Buffer.alloc(8);
header.write('icns');
header.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4);
await save('icon.icns', Buffer.concat([header, ...chunks]));
await save('icon.png', images.get(512));
console.log('Generated build/icon.ico, build/icon.icns and build/icon.png from assets/logo-icon.svg');
