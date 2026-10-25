'use strict';

const crypto = require('crypto');
const zlib = require('zlib');

const WIDTH = 190;
const HEIGHT = 56;
const GLYPHS = {
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'], B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'], D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'], F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10111', '10001', '10001', '01111'], H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'], J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'], L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'], N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'], P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'], R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'], T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'], V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'], X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'], Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111']
};

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let value = n;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crcTable[n] = value >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, checksum]);
}

function setPixel(pixels, x, y, color) {
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
  const offset = (y * WIDTH + x) * 3;
  pixels[offset] = color[0];
  pixels[offset + 1] = color[1];
  pixels[offset + 2] = color[2];
}

function renderCaptchaPng(code) {
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) setPixel(pixels, x, y, [248, 249, 250]);
  }

  for (let i = 0; i < 150; i++) {
    const x = crypto.randomInt(WIDTH);
    const y = crypto.randomInt(HEIGHT);
    const shade = crypto.randomInt(170, 220);
    setPixel(pixels, x, y, [shade, shade, shade]);
  }
  for (let line = 0; line < 5; line++) {
    let x = crypto.randomInt(WIDTH);
    let y = crypto.randomInt(HEIGHT);
    const color = [crypto.randomInt(175, 215), crypto.randomInt(175, 215), crypto.randomInt(175, 215)];
    for (let step = 0; step < 45; step++) {
      setPixel(pixels, x, y, color);
      x += crypto.randomInt(-1, 3);
      y += crypto.randomInt(-1, 2);
    }
  }

  const cell = 5;
  const gap = 4;
  const textWidth = code.length * (5 * cell) + (code.length - 1) * gap;
  const startX = Math.floor((WIDTH - textWidth) / 2);
  code.toUpperCase().split('').forEach(function(char, index) {
    const rows = GLYPHS[char];
    if (!rows) return;
    const originX = startX + index * (5 * cell + gap) + crypto.randomInt(-2, 3);
    const originY = 9 + crypto.randomInt(-3, 4);
    const angle = (crypto.randomInt(-9, 10) * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const centerX = originX + 12;
    const centerY = originY + 17;
    const color = [crypto.randomInt(35, 75), crypto.randomInt(45, 90), crypto.randomInt(55, 100)];
    rows.forEach(function(row, y) {
      for (let x = 0; x < row.length; x++) {
        if (row[x] !== '1') continue;
        for (let py = 0; py < cell; py++) {
          for (let px = 0; px < cell; px++) {
            const dx = x * cell + px - 12;
            const dy = y * cell + py - 17;
            const jitterX = crypto.randomInt(-1, 2);
            const jitterY = crypto.randomInt(-1, 2);
            setPixel(pixels, Math.round(centerX + dx * cos - dy * sin + jitterX), Math.round(centerY + dx * sin + dy * cos + jitterY), color);
          }
        }
      }
    });
  });

  const scanlines = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) pixels.copy(scanlines, y * (WIDTH * 3 + 1), y * WIDTH * 3, (y + 1) * WIDTH * 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(WIDTH, 0);
  ihdr.writeUInt32BE(HEIGHT, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const chunks = [pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(scanlines)), pngChunk('IEND', Buffer.alloc(0))];
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks]);
}

module.exports = { renderCaptchaPng };
