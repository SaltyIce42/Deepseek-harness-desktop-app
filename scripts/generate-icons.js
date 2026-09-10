'use strict';

/**
 * One-off asset generator for the app/tray icons.
 *
 * The project itself has **zero build steps** at runtime — this script only exists so the
 * committed binary icons in `assets/` can be regenerated reproducibly from `assets/icon.svg`
 * whenever branding changes:
 *
 *     npm run icons
 *
 * It uses `@resvg/resvg-js` (a devDependency; prebuilt, no compiler needed) to rasterise the
 * SVG, then assembles a multi-size PNG-compressed `.ico` by hand so we do not need an
 * image-processing toolchain just for packaging.
 *
 * Note: `electron-builder` also derives `build/icon.ico` from `assets/icon.svg` on demand.
 * The committed files exist so `assets/icon.ico` / `assets/tray.png` are available to the
 * app at runtime (tray icon) and auditable in the repository.
 */

const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const ASSETS = path.join(__dirname, '..', 'assets');
const SOURCE = path.join(ASSETS, 'icon.svg');
const LIGHT_SOURCE = path.join(ASSETS, 'icon-light.svg');

/** ICO container sizes (Windows convention). */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
/**
 * Tray icon sizes, @1x and @2x. Written as two files so Electron picks the right one.
 * The Windows tray sits on a dark taskbar, so the tray mark is the *light* variant.
 */
const TRAY_SIZES = [16, 32];

/**
 * Rasterise the source SVG at an exact pixel size.
 *
 * @param {string} svg SVG document text.
 * @param {number} size Target edge length in pixels (square).
 * @returns {Buffer} PNG bytes.
 */
function renderPng(svg, size) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    background: 'rgba(0,0,0,0)',
  });
  return resvg.render().asPng();
}

/**
 * Build a PNG-compressed `.ico` file from pre-rendered PNGs.
 *
 * The ICO container is a 6-byte header followed by one 16-byte directory entry per image,
 * then the payloads. For PNG payloads every "length" style field is simply 0.
 *
 * @param {{size: number, png: Buffer}[]} images Non-empty list, ascending size.
 * @returns {Buffer} Complete `.ico` bytes.
 */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;

  images.forEach((image, index) => {
    const entry = index * 16;
    // 256 is encoded as 0 in the single-byte width/height fields.
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, entry + 0);
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, entry + 1);
    directory.writeUInt8(0, entry + 2); // palette size (0 = true colour)
    directory.writeUInt8(0, entry + 3); // reserved
    directory.writeUInt16LE(1, entry + 4); // colour planes
    directory.writeUInt16LE(32, entry + 6); // bits per pixel
    directory.writeUInt32LE(image.png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += image.png.length;
  });

  return Buffer.concat([header, directory, ...images.map((image) => image.png)]);
}

function main() {
  if (!fs.existsSync(SOURCE)) {
    throw new Error(`Source SVG not found: ${SOURCE}`);
  }
  const svg = fs.readFileSync(SOURCE, 'utf8');

  const icoImages = ICO_SIZES.map((size) => ({ size, png: renderPng(svg, size) }));
  const icoPath = path.join(ASSETS, 'icon.ico');
  fs.writeFileSync(icoPath, buildIco(icoImages));
  console.log(`wrote ${path.relative(process.cwd(), icoPath)} (${ICO_SIZES.join(', ')} px)`);

  if (!fs.existsSync(LIGHT_SOURCE)) {
    throw new Error(`Light source SVG not found: ${LIGHT_SOURCE}`);
  }
  const lightSvg = fs.readFileSync(LIGHT_SOURCE, 'utf8');
  TRAY_SIZES.forEach((size) => {
    const trayPath = path.join(ASSETS, `tray${size === 16 ? '' : '@2x'}.png`);
    fs.writeFileSync(trayPath, renderPng(lightSvg, size));
    console.log(`wrote ${path.relative(process.cwd(), trayPath)} (${size} px)`);
  });
}

main();
