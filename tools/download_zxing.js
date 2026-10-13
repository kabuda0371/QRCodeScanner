// 下载 zxing-wasm 包，提取 UMD 与 wasm 文件到 lib/
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const python = 'C:\\Users\\ZYX\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';
const ROOT = path.join(__dirname, '..');

(async () => {
  // 1. 查询最新版本
  const meta = await (await fetch('https://registry.npmjs.org/zxing-wasm/latest')).json();
  console.log('version:', meta.version, 'tarball:', meta.dist.tarball);

  // 2. 下载 tarball
  const res = await fetch(meta.dist.tarball);
  if (!res.ok) throw new Error('下载失败 ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  const tgz = path.join(ROOT, 'tools', 'zxing-wasm.tgz');
  fs.writeFileSync(tgz, buf);
  console.log('tgz size:', buf.length);

  // 3. 用 Python tarfile 解压（Node 无内置 tar）
  const pkgDir = path.join(ROOT, 'tools', 'zxing-pkg');
  fs.rmSync(pkgDir, { recursive: true, force: true });
  fs.mkdirSync(pkgDir, { recursive: true });
  execSync(`"${python}" -c "import tarfile,sys; tarfile.open(sys.argv[1]).extractall(sys.argv[2])" "${tgz}" "${pkgDir}"`, { stdio: 'inherit' });

  // 4. 列出 dist 内容
  const dist = path.join(pkgDir, 'package', 'dist');
  const walk = (d, pre = '') => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, pre + e.name + '/');
      else console.log(pre + e.name, fs.statSync(p).size);
    }
  };
  walk(dist);

  // 5. 复制 UMD 与 wasm 到 lib/
  const candidates = [];
  const find = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) find(p);
      else if (/\.(js|mjs|wasm)$/.test(e.name)) candidates.push(p);
    }
  };
  find(path.join(pkgDir, 'package'));
  console.log('--- candidates ---');
  candidates.forEach((c) => console.log(c.replace(pkgDir, '')));
})();
