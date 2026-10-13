# 二维码识别助手（QR Scanner）

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)](./manifest.json)
[![License](https://img.shields.io/badge/License-MIT-green)](./LICENSE)

一个 **Chrome / Edge 浏览器扩展**，解决「网页里的二维码无法右键扫码」的问题——尤其针对**公众号文章**和**网申页面**里的各种二维码。

> 公众号文章、网申页面里的二维码经常无法用电脑直接扫描：右键没有识别选项、截图再传手机又麻烦。装上这个扩展，**右键图片一键识别**，识别内容可以直接复制或跳转。

- ✅ 右键图片 → 一键识别，无需截图、无需手机
- ✅ 三重识别引擎（zxing-cpp + jsQR + 浏览器原生），识别率业界顶级
- ✅ 全程本地识别，不收集、不上传任何数据

---

## ✨ 功能

| 操作 | 效果 |
| --- | --- |
| 在二维码图片上**右键** →「🔍 识别此图片中的二维码」 | 弹出结果卡片：显示内容 + 一键复制 / 打开链接 |
| 在页面上**右键** →「✂️ 框选区域识别二维码」 | 鼠标拖拽框选任意屏幕区域识别（视频、海报角落、截图里的码都能扫） |
| 在页面空白处**右键** →「🔍 扫描本页所有二维码」 | 自动扫描整页所有图片（含 CSS 背景图），列出全部二维码 |
| 点击工具栏图标 | 等同「扫描本页所有二维码」 |

自动识别内容类型：链接、微信（`weixin://`）、WiFi 配置（`WIFI:`）、电话（`tel:`）、邮箱（`mailto:`）、名片（`vCard`）、普通文本。

### 交互体验

- **过程透明**：识别时右上角出现小卡片，实时显示当前步骤（⏳ 等待图片加载 → ① 读取图片 → ② 后台抓取原图 → ③ 屏幕截图识别 → ① 快速引擎 / ② 增强引擎识别）
- **消息不堆积**：所有提示在同一张卡片上原地更新；点击「复制」或「打开链接」后卡片和提示自动清空
- **随时取消**：状态卡上的 ✕ 或按 `Esc` 立即终止，不会再有结果弹回来

### 针对公众号文章的专门优化

- **弹窗二维码**：微信「跳转二维码」的图片地址是弹窗打开后才由 JS 动态填充的——扩展会**先等待图片加载完成再识别**，不再误报失败
- **Referer 校验**：部分微信图床（mmbiz.qpic.cn）校验来源页，后台抓图会自动带来源页重试
- **防挂起**：抓图、截图、识别引擎全部带超时保护，网络卡死也不会让扫描永远转圈

---

## 📦 安装（30 秒）

1. 下载本仓库（Code → Download ZIP，或 `git clone`），解压
2. **Chrome**：地址栏输入 `chrome://extensions` 回车 → 打开右上角「**开发者模式**」→ 点「**加载已解压的扩展程序**」→ 选择本文件夹
3. **Edge**：地址栏输入 `edge://extensions` 回车 → 打开左侧「**开发人员模式**」→ 点「**加载解压缩的扩展**」→ 选择本文件夹
4. 安装后**刷新已打开的网页**即可生效

> 360 极速浏览器、QQ 浏览器等 Chromium 内核浏览器大多也支持同样的「加载已解压扩展」方式。
> 升级新版：`chrome://extensions` → 移除旧版 → 重新加载本文件夹。

---

## 🧪 验证安装

双击打开 `test/test.html`（若右键菜单未出现：`chrome://extensions` → 本扩展「**详细信息**」→ 开启「**允许访问文件网址**」，然后刷新测试页）。

页面内置 11 个测试二维码，覆盖常规与困难场景：

| # | 场景 | 内容 |
| --- | --- | --- |
| ① | 常规链接码 | https://www.baidu.com |
| ② | 中文文本码 | 中文内容识别 |
| ③ | WiFi 配置码 | `WIFI:S:MyWifi;...` |
| ④ | 小尺寸码 | 150px |
| ⑤ | 跨域图片 | 公众号同款图床路径（需联网） |
| ⑥ | CSS 背景图码 | 用「扫描本页所有二维码」测试 |
| ⑦ | 海报角落小码 | 1200×800 海报右下角 220px 二维码 |
| ⑧ | 彩色二维码 | 深蓝模块 |
| ⑨ | 微型二维码 | 仅 60px |
| ⑩ | 旋转二维码 | 旋转 25°（仅 zxing 引擎可识别） |
| ⑪ | 延迟加载二维码 | 模拟微信跳转弹窗：src 1 秒后才被 JS 填充 |

- 页面自动显示「✅ 自动验证通过」= 扩展已在工作
- 逐个右键测试「识别此图片中的二维码」
- 空白处右键测试「扫描本页所有二维码」（一次扫出全部 10 个）
- 用「框选区域识别二维码」框选 ⑦ 海报中的小码试试

---

## 🔬 工作原理

### 三重识别引擎（按序尝试，专治低识别率）

1. **浏览器原生 BarcodeDetector**：最快，多尺度尝试
2. **jsQR**：原始图 + Otsu 自适应二值化预处理（低对比度/彩色码），多尺度尝试
3. **zxing-cpp WASM 引擎**（v3.1.5）：局部自适应二值化、多区域搜索、**旋转码 / 反色码 / 微型码 / 海报角落小码**都能识别

### 图片获取三重路径

1. **直接绘制**：同源图片直接在页面里解码，最快
2. **后台抓图**：跨域图片（如公众号图床）由扩展后台抓取原图再解码，解决浏览器「画布污染」限制
3. **屏幕截图兜底**：前两步失败时，截取图片在屏幕上的可见区域解码

### 框选识别的实现（三重路径）

1. **页面图片裁剪**：框选区域若落在某张 `<img>` 上，直接从图片像素按比例裁剪识别（毫秒级、不依赖截图 API；跨域图自动改走后台抓图后裁剪）
2. **屏幕截图**：区域不在图片上时（视频、canvas 等）才调用截图 API，自动重试 2 次
3. 任何一步失败都会**用结果卡片替换进度卡**并显示具体原因

---

## 🔒 权限与隐私

- 提示的「读取所有网站数据」权限**仅用于**：识别你右键选中的图片时需要读取图片像素（后台抓取原图、屏幕截图）；没有任何后台收集或上传行为
- 识别全部在浏览器本地完成：解码引擎（zxing-cpp / jsQR）随扩展打包运行，不发请求到任何第三方识别服务
- 不注入广告、不修改页面内容、不读取浏览历史

---

## ❓ 常见问题

**右键菜单没出现？**
扩展安装后需要刷新已打开的网页；`chrome://`、扩展商店等内置页面不支持。

**自动识别失败？**
按推荐顺序尝试：
1. 右键 →「✂️ 框选区域识别二维码」，把二维码连同白边一起框进去
2. 放大页面（Ctrl + 滚轮）后重试
3. 把图片完整滚动到屏幕内再右键
4. 右键 →「🔍 扫描本页所有二维码」

---

## 📁 项目结构

```
QRCodeScanner/
├── manifest.json          # 扩展清单（Manifest V3）
├── background.js          # 后台 Service Worker：右键菜单、抓图、屏幕截图
├── content.js             # 内容脚本：识别流水线、框选交互与结果面板
├── lib/
│   ├── jsQR.js            # jsQR 解码库 v1.4.0（MIT，已打包）
│   ├── zxing.js           # zxing-wasm v3.1.5 运行时
│   └── zxing_reader.wasm  # zxing-cpp 解码引擎
├── icons/                 # 扩展图标
├── test/test.html         # 测试页（内置 11 个测试二维码，自包含）
└── tools/                 # 开发脚本（见下）
```

---

## 🛠 开发

### 工具脚本

| 脚本 | 用途 |
| --- | --- |
| `tools/build_test.py` | 下载测试二维码并生成 `test/test.html`（含全部内嵌素材）；依赖 Pillow |
| `tools/download_jsqr.js` | 从 npm 下载 jsQR 库到 `lib/jsQR.js` |
| `tools/download_zxing.js` | 从 npm 下载 zxing-wasm 包，提取运行时与 wasm 到 `lib/` |
| `tools/make_icons.py` | 用 Pillow 生成扩展图标（4× 超采样抗锯齿） |
| `tools/test_decode.js` | 离线验证 jsQR 解码（需先运行 `build_test.py` 生成 PGM 素材） |

```bash
# 重新生成测试素材（test/*.png、*.pgm 与 test.html）
python tools/build_test.py

# 离线验证解码
node tools/test_decode.js

# 更新解码库
node tools/download_jsqr.js
node tools/download_zxing.js
```

### 打包分发

Chrome 商店外分发只需打包文件夹本身（含 `lib/`、`icons/` 即可运行）：

```powershell
Compress-Archive -Path manifest.json, background.js, content.js, lib, icons -DestinationPath QRScanner-extension.zip
```

### 自动化验证

已通过的验证（开发过程中持续执行）：

- jsQR 离线解码测试（Node）
- headless 浏览器端到端测试（扩展加载 → 内容脚本注入 → 11 用例全部识别 → 整页扫描 → 框选流水线）

---

## 🧰 技术栈

- [Chrome Extensions Manifest V3](https://developer.chrome.com/docs/extensions/mv3/)（兼容 Chrome 106+）
- [jsQR](https://github.com/cozmo/jsQR) v1.4.0（MIT）
- [zxing-wasm](https://github.com/Sec-ant/zxing-wasm) v3.1.5 / zxing-cpp（MIT）
- 识别顺序：原生引擎 → jsQR（+Otsu 二值化，多尺度）→ zxing-cpp（tryHarder / tryRotate / tryInvert / tryDownscale，LocalAverage 自适应二值化）
- 单图识别上限 2200px、整页扫描 1100px，自动平衡速度与识别率

## 📄 License

[MIT](./LICENSE) © 2025 QRCodeScanner contributors

jsQR 与 zxing-wasm 版权归其原作者（均为 MIT 许可）。
