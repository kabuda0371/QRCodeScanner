// 离线验证：用 jsQR 解码 test/*.pgm，确认解码库可用且二维码内容正确
const fs = require('fs');
const path = require('path');
const jsQR = require('../lib/jsQR.js');

function parsePgm(buf) {
  let i = 0;
  const readToken = () => {
    for (;;) {
      if (i >= buf.length) return '';
      const c = buf[i];
      if (c === 0x23) { // 注释行
        while (i < buf.length && buf[i] !== 0x0a) i++;
        continue;
      }
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) { i++; continue; }
      break;
    }
    const start = i;
    while (i < buf.length && ![0x20, 0x0a, 0x0d, 0x09, 0x23].includes(buf[i])) i++;
    return buf.toString('ascii', start, i);
  };
  if (readToken() !== 'P5') throw new Error('不是 P5 灰度 PGM');
  const w = parseInt(readToken(), 10);
  const h = parseInt(readToken(), 10);
  parseInt(readToken(), 10); // maxval
  i++; // 头部与数据之间的单个空白字符
  if (!(w > 0 && h > 0) || i + w * h > buf.length) throw new Error('PGM 尺寸非法');
  const data = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    const v = buf[i + p];
    const o = p * 4;
    data[o] = data[o + 1] = data[o + 2] = v;
    data[o + 3] = 255;
  }
  return { data, width: w, height: h };
}

const cases = [
  ['test/qr1.pgm', 'https://www.baidu.com'],
  ['test/qr2.pgm', '恭喜！网申二维码识别测试通过'],
  ['test/qr3.pgm', 'WIFI:S:MyWifi;T:WPA;P:12345678;;'],
  ['test/qr4.pgm', 'https://github.com'],
];

let failed = 0;
for (const [file, expect] of cases) {
  const id = parsePgm(fs.readFileSync(path.join(__dirname, '..', file)));
  const code = jsQR(id.data, id.width, id.height, { inversionAttempts: 'attemptBoth' });
  const ok = code && code.data && code.data.trim() === expect.trim();
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${file}  =>  ${code ? JSON.stringify(code.data) : 'null'}`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
