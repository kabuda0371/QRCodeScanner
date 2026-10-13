# -*- coding: utf-8 -*-
"""下载测试二维码图片，生成 test/test.html 测试页与 test/*.pgm 灰度文件。

test.html 会把二维码以 data URI 形式内嵌，离线可用；
*.pgm 供 Node 自动化测试使用（jsQR 解码验证）。
"""
import base64
import io
import random
import sys
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
TEST = ROOT / "test"
TEST.mkdir(exist_ok=True)

# (文件名, 二维码内容, 尺寸, 是否参与自动断言)
CASES = [
    ("qr1.png", "https://www.baidu.com", 300, True),
    ("qr2.png", "恭喜！网申二维码识别测试通过", 300, True),
    ("qr3.png", "WIFI:S:MyWifi;T:WPA;P:12345678;;", 300, True),
    ("qr4.png", "https://github.com", 150, True),
    ("qr5.png", "https://www.example.com/network-test", 300, False),
]

PROVIDERS = [
    # (名称, URL 模板) —— url 中 {size} 和 {data} 会被替换
    ("qrserver", "https://api.qrserver.com/v1/create-qr-code/?size={size}x{size}&data={data}"),
    ("quickchart", "https://quickchart.io/qr?text={data}&size={size}&margin=2"),
    ("quickchart-old", "https://quickchart.io/qrcode?text={data}&size={size}&margin=2"),
]


def download(name, data, size):
    out = TEST / name
    last_err = None
    for prov, tmpl in PROVIDERS:
        url = tmpl.format(size=size, data=urllib.parse.quote(data, safe=""))
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read()
            # 校验 PNG 魔数（二维码 PNG 压缩率极高，几百字节也正常）
            if len(raw) < 200 or raw[:8] != b"\x89PNG\r\n\x1a\n":
                raise RuntimeError(f"非法响应，长度 {len(raw)}，头 {raw[:16]!r}")
            img = Image.open(io.BytesIO(raw))
            img.verify()  # 校验图片可解析
            if img.size[0] < 50 or img.size[1] < 50:
                raise RuntimeError(f"图片过小 {img.size}")
            out.write_bytes(raw)
            print(f"downloaded {name} via {prov} ({len(raw)} bytes, {img.size})")
            break
        except Exception as e:
            last_err = e
            print(f"  provider {prov} failed: {e}")
    else:
        raise RuntimeError(f"{name}: 所有下载源失败 -> {last_err}")

    # 生成 PGM 灰度文件（Node 测试用；Pillow 用格式名 "PPM"，mode=L 时写为 P5）
    img = Image.open(out).convert("L")
    buf = io.BytesIO()
    img.save(buf, format="PPM")
    (TEST / (name.replace(".png", ".pgm"))).write_bytes(buf.getvalue())
    return base64.b64encode(raw).decode(), base64.b64encode(buf.getvalue()).decode()


def build_html(assets):
    def img_block(name, expect, data_uri, pgm_uri, caption, attrs="", live_src=""):
        src = f'src="{data_uri}"' if data_uri else f'src="{live_src}"'
        selftest = ""
        if expect is not None:
            selftest = f' data-selftest="{html_escape(expect)}"'
            if pgm_uri:
                selftest += f' data-selftest-pgm="{pgm_uri}"'
        return f"""
        <div class="qr-block" data-id="{name}">
          <img class="qr-img" {src} alt="测试二维码" {attrs}{selftest}>
          <div class="caption">{caption}</div>
          <div class="status" data-status-for="{name}">等待识别…</div>
        </div>"""

    blocks = []
    blocks.append(img_block(
        "qr1", "https://www.baidu.com", assets["qr1"][0], assets["qr1"][1],
        "① 链接二维码（期望识别出 https://www.baidu.com）—— 右键图片测试"))
    blocks.append(img_block(
        "qr2", "恭喜！网申二维码识别测试通过", assets["qr2"][0], assets["qr2"][1],
        "② 中文文本二维码 —— 右键图片测试"))
    blocks.append(img_block(
        "qr3", "WIFI:S:MyWifi;T:WPA;P:12345678;;", assets["qr3"][0], assets["qr3"][1],
        "③ WiFi 配置二维码 —— 右键图片测试"))
    blocks.append(img_block(
        "qr4", "https://github.com", assets["qr4"][0], assets["qr4"][1],
        "④ 小尺寸二维码（150px）—— 右键图片测试"))
    blocks.append(img_block(
        "qr5", None, None, None,
        "⑤ 跨域图片二维码（需联网，测试后台抓取路径）—— 右键图片测试",
        attrs='id="qr5"',
        live_src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=https%3A%2F%2Fwww.example.com%2Fnetwork-test"))

    # CSS 背景图二维码
    bg_block = f"""
        <div class="qr-block" data-id="qrbg">
          <div class="qr-bg" data-selftest-bg="https://www.baidu.com"
               style="width:300px;height:300px;background-image:url('{assets['qr1'][0]}');background-size:contain;background-repeat:no-repeat;"></div>
          <div class="caption">⑥ CSS 背景图二维码 —— 用「扫描本页所有二维码」测试</div>
          <div class="status" data-status-for="qrbg">等待识别…</div>
        </div>"""

    # 困难场景测试
    blocks.append(img_block(
        "qr6", "https://www.baidu.com", assets["qr6"][0], None,
        "⑦ 海报图：二维码藏在 1200×800 右下角（困难场景）—— 右键图片测试"))
    blocks.append(img_block(
        "qr7", "恭喜！网申二维码识别测试通过", assets["qr7"][0], None,
        "⑧ 彩色二维码（深蓝模块）—— 右键图片测试"))
    blocks.append(img_block(
        "qr8", "https://github.com", assets["qr8"][0], None,
        "⑨ 微型二维码（60px）—— 右键图片测试"))
    blocks.append(img_block(
        "qr9", "恭喜！网申二维码识别测试通过", assets["qr9"][0], None,
        "⑩ 旋转 25° 的二维码（jsQR 不支持旋转，验证 zxing 引擎）—— 右键图片测试"))

    # 模拟微信跳转弹窗：二维码 src 延迟 1 秒才被 JS 动态填充
    late_block = f"""
        <div class="qr-block" data-id="qrlate">
          <img id="qr-late" class="qr-img" src="" data-late-src="{assets['qr1'][0]}" alt="延迟加载二维码"
               data-selftest="https://www.baidu.com">
          <div class="caption">⑪ 延迟加载的二维码（模拟微信跳转弹窗：src 1 秒后才被 JS 填充）—— 右键图片测试</div>
          <div class="status" data-status-for="qrlate">等待识别…</div>
        </div>"""
    blocks.append(late_block)

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>二维码识别助手 - 测试页</title>
<style>
  body {{ margin: 0; background: #f5f5f5; font-family: "Segoe UI","Microsoft YaHei",sans-serif; color: #222; }}
  .article {{ max-width: 640px; margin: 0 auto; background: #fff; padding: 32px 24px 60px; min-height: 100vh; }}
  .title {{ font-size: 22px; font-weight: 700; margin-bottom: 8px; }}
  .meta {{ color: #888; font-size: 13px; margin-bottom: 20px; }}
  .tip {{ background: #e8f0fe; border-radius: 8px; padding: 12px 16px; font-size: 13px; color: #1a56a8; margin: 16px 0; line-height: 1.8; }}
  p {{ line-height: 1.9; color: #333; }}
  .qr-block {{ text-align: center; margin: 28px 0; padding: 16px; border: 1px dashed #ccc; border-radius: 10px; background: #fafafa; }}
  .qr-img {{ max-width: 100%; display: inline-block; }}
  .qr-bg {{ display: inline-block; }}
  .caption {{ font-size: 13px; color: #666; margin-top: 10px; }}
  .status {{ font-size: 14px; margin-top: 8px; font-weight: 600; }}
  .status.pass {{ color: #0a8043; }}
  .status.fail {{ color: #d93025; }}
</style>
</head>
<body>
  <div class="article" data-qrscanner-autoscan>
    <div class="title">二维码识别助手 · 测试页</div>
    <div class="meta">模拟公众号文章页 · 用于验证扩展安装成功</div>
    <div class="tip">
      <b>使用说明：</b><br>
      1. 在下方任意二维码图片上 <b>右键</b> → 选择「🔍 识别此图片中的二维码」<br>
      2. 或在页面空白处 <b>右键</b> → 「🔍 扫描本页所有二维码」（会同时找到①~⑥）<br>
      3. 页面上的「✅ 自动验证」是扩展自测结果；「等待识别…」表示扩展尚未在本页生效
    </div>
    <p>这是一段模拟公众号文章正文的文字。许多网申信息都通过公众号文章发布，
    二维码常常嵌在文章配图或底部，直接右键无法扫码。本扩展正是为此而生。</p>
    {''.join(blocks)}
    {bg_block}
    <p style="text-align:center;color:#999;">—— 测试结束 ——</p>
  </div>
<script>
  // 模拟微信跳转弹窗：二维码 src 延迟 1 秒才被 JS 动态填充
  setTimeout(function () {{
    var img = document.getElementById('qr-late');
    if (img) img.src = img.getAttribute('data-late-src');
  }}, 1000);
  // 自动化测试模式：跨域二维码改用本地 8124 端口（避免外网波动影响测试确定性）
  if (location.search.indexOf('e2e') >= 0) {{
    var q5 = document.getElementById('qr5');
    if (q5) q5.src = 'http://127.0.0.1:8124/test/qr5.png';
  }}
</script>
<script>
  (function () {{
    function refresh() {{
      document.querySelectorAll('[data-status-for]').forEach(function (st) {{
        var target = document.querySelector('[data-id="' + st.getAttribute('data-status-for') + '"] [data-selftest],'
          + '[data-id="' + st.getAttribute('data-status-for') + '"] [data-selftest-bg]');
        if (!target) return;
        var r = target.getAttribute('data-selftest-result');
        if (!r) return;
        if (r === 'PASS') {{ st.textContent = '✅ 自动验证通过'; st.className = 'status pass'; }}
        else {{ st.textContent = '❌ ' + r; st.className = 'status fail'; }}
      }});
    }}
    setInterval(refresh, 500);
    refresh();
  }})();
</script>
</body>
</html>"""
    (TEST / "test.html").write_text(html, encoding="utf-8")
    print("wrote test/test.html")


def html_escape(s):
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
             .replace('"', "&quot;"))


def data_uri_of(name):
    raw = (TEST / name).read_bytes()
    return f"data:image/png;base64,{base64.b64encode(raw).decode()}"


def make_composite():
    """困难场景：1200x800 渐变海报，二维码藏在右下角 220px，周围有文字块与噪点"""
    W, H = 1200, 800
    img = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(img)
    for y in range(H):
        t = y / H
        d.line([(0, y), (W, y)], fill=(int(205 + 35 * t), int(218 + 18 * t), int(235 - 22 * t)))
    rng = random.Random(7)
    for _ in range(70):
        x = rng.randint(10, 900)
        y = rng.randint(10, 750)
        w = rng.randint(50, 260)
        h = rng.randint(5, 14)
        g = 110 + rng.randint(-45, 45)
        d.rectangle([x, y, x + w, y + h], fill=(g, g, g))
    qr = Image.open(TEST / "qr1.png").resize((220, 220), Image.LANCZOS)
    qx, qy = W - 260, H - 260
    img.paste(qr, (qx, qy))
    # 噪点（避开二维码区域）
    for _ in range(4000):
        x = rng.randint(0, W - 1)
        y = rng.randint(0, H - 1)
        if qx - 30 <= x <= qx + 250 and qy - 30 <= y <= qy + 250:
            continue
        v = rng.randint(0, 255)
        img.putpixel((x, y), (v, v, v))
    img.save(TEST / "qr6.png")
    print("generated qr6.png (composite poster)")


def make_colored():
    """困难场景：深蓝色模块的彩色二维码"""
    img = Image.open(TEST / "qr2.png").convert("RGB")
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            lum = (r * 299 + g * 587 + b * 114) // 1000
            if lum > 128:
                px[x, y] = (240, 246, 255)
            else:
                px[x, y] = (16, 48, 138)
    img.save(TEST / "qr7.png")
    print("generated qr7.png (colored QR)")


def make_rotated():
    """困难场景：旋转 25° 的二维码（jsQR 不支持旋转，用于验证 zxing 引擎）"""
    img = Image.open(TEST / "qr2.png").convert("RGB")
    img = img.rotate(25, resample=Image.BICUBIC, expand=True, fillcolor=(255, 255, 255))
    img.save(TEST / "qr9.png")
    rgba = img.convert("RGBA")
    (TEST / "qr9.bin").write_bytes(rgba.tobytes())
    (TEST / "qr9.dims").write_text(f"{rgba.width},{rgba.height}")
    print(f"generated qr9.png (rotated QR, {rgba.width}x{rgba.height})")


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    assets = {}
    for name, data, size, auto in CASES:
        png_b64, pgm_b64 = download(name, data, size)
        assets[name.replace(".png", "")] = (f"data:image/png;base64,{png_b64}", pgm_b64)
    # 困难场景测试图（本地生成，走完整识别流水线验证）
    make_composite()
    make_colored()
    make_rotated()
    png_b64, _pgm_b64 = download("qr8.png", "https://github.com", 60)
    assets["qr6"] = (data_uri_of("qr6.png"), None)
    assets["qr7"] = (data_uri_of("qr7.png"), None)
    assets["qr8"] = (f"data:image/png;base64,{png_b64}", None)
    assets["qr9"] = (data_uri_of("qr9.png"), None)
    build_html(assets)
    print("OK")


if __name__ == "__main__":
    sys.exit(main())
