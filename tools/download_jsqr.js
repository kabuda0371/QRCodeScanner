// 下载 jsQR 解码库（UMD 构建）
const fs = require('fs');
const path = require('path');

const outFile = path.join(__dirname, '..', 'lib', 'jsQR.js');
const urls = [
  'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js',
  'https://unpkg.com/jsqr@1.4.0/dist/jsQR.js',
  'https://registry.npmmirror.com/jsqr/1.4.0/files/dist/jsQR.js',
];

(async () => {
  for (const u of urls) {
    try {
      console.log('try', u);
      const res = await fetch(u, { redirect: 'follow' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      if (text.length < 50000) throw new Error('内容异常, 长度 ' + text.length);
      fs.writeFileSync(outFile, text, 'utf8');
      console.log('OK  size=' + text.length);
      console.log('HEAD:', text.slice(0, 80).replace(/\n/g, ' '));
      return;
    } catch (e) {
      console.log('FAILED:', e.message);
    }
  }
  console.error('ALL FAILED');
  process.exit(1);
})();
