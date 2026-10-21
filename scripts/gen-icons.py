#!/usr/bin/env python3
# token-pilot 图标生成 — 借 CatPaw 雷达底稿风格，换品牌闪电+橙红渐变
# 产出：menubar/src-tauri/icons/icon.png（1024 app 图标）+ tray.png（44 单色模板图标）

from PIL import Image, ImageDraw, ImageFilter
import math
import os

OUT = os.path.join(os.path.dirname(__file__), '..', 'menubar', 'src-tauri', 'icons')
os.makedirs(OUT, exist_ok=True)

# 品牌色（与设计体系 oklch 对应）
C_ORANGE = (255, 122, 69)    # accent
C_PINK = (255, 77, 109)      # accent-2
C_VIOLET = (178, 102, 255)   # accent-3
C_BG = (22, 24, 43)          # 深夜蓝底
C_BG2 = (31, 34, 56)

BOLT = [(13, 2), (4, 14), (10, 14), (9, 22), (20, 10), (14, 10)]  # 24px viewBox 闪电路径转多边形

def bolt_poly(cx, cy, w, h):
    """以 (cx,cy) 为中心、宽 w 高 h 的闪电多边形"""
    return [(cx - w/2 + px/24*w, cy - h/2 + py/24*h) for px, py in BOLT]

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i]-a[i])*t) for i in range(3))

def vgrad(draw_fn, box, c_top, c_bottom):
    """竖直渐变填充：逐行画"""
    x0, y0, x1, y1 = box
    im = Image.new('RGBA', (x1-x0, y1-y0), (0,0,0,0))
    d = ImageDraw.Draw(im)
    for y in range(y1-y0):
        d.line([(0,y),(x1-x0,y)], fill=lerp(c_top, c_bottom, y/(y1-y0)) + (255,))
    mask = Image.new('L', (x1-x0, y1-y0), 0)
    md = ImageDraw.Draw(mask)
    draw_fn(md)
    return im, mask, (x0, y0)

# ============ App 图标 1024 ============
S = 1024
SS = 4  # 超采样抗锯齿
W = S * SS
img = Image.new('RGBA', (W, W), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 圆角方底（macOS 风格 22% 半径）+ 微渐变
body = Image.new('RGBA', (W, W), (0,0,0,0))
bd = ImageDraw.Draw(body)
for y in range(W):
    bd.line([(0,y),(W,y)], fill=lerp(C_BG2, C_BG, y/W) + (255,))
mask = Image.new('L', (W, W), 0)
ImageDraw.Draw(mask).rounded_rectangle([0,0,W-1,W-1], radius=int(W*0.225), fill=255)
img.paste(body, (0,0), mask)
d = ImageDraw.Draw(img)

cx = cy = W/2

# 雷达同心圆环 + 十字线（品牌橙，低透明）
ring = Image.new('RGBA', (W, W), (0,0,0,0))
rd = ImageDraw.Draw(ring)
for r, alpha in [(0.36, 200), (0.26, 120), (0.16, 80)]:
    rr = W * r
    rd.ellipse([cx-rr, cy-rr, cx+rr, cy+rr], outline=C_ORANGE + (alpha,), width=int(W*0.004))
rd.line([(cx - W*0.36, cy), (cx + W*0.36, cy)], fill=C_ORANGE + (60,), width=int(W*0.002))
rd.line([(cx, cy - W*0.36), (cx, cy + W*0.36)], fill=C_ORANGE + (60,), width=int(W*0.002))
img = Image.alpha_composite(img, ring)

# 雷达扫掠扇形（橙→粉渐变，向尾缘渐隐）
sweep = Image.new('RGBA', (W, W), (0,0,0,0))
sd = ImageDraw.Draw(sweep)
R = W * 0.36
A0, A1 = -75, -20  # 扫掠角（12 点方向附近）
steps = 60
for i in range(steps):
    a = A0 + (A1-A0) * i/steps
    t = i/steps
    col = lerp(C_ORANGE, C_PINK, t)
    alpha = int(10 + 120*t)   # 尾缘亮
    sd.pieslice([cx-R, cy-R, cx+R, cy+R], start=a, end=a + (A1-A0)/steps + 0.5, fill=col + (alpha,))
sweep = sweep.filter(ImageFilter.GaussianBlur(W*0.004))
img = Image.alpha_composite(img, sweep)

# 雷达点（小圆点装饰）
d = ImageDraw.Draw(img)
for ang, rr, s, col in [(145, 0.24, 0.012, C_ORANGE), (30, 0.30, 0.010, C_PINK), (255, 0.20, 0.011, C_VIOLET)]:
    px = cx + math.cos(math.radians(ang)) * W * rr
    py = cy + math.sin(math.radians(ang)) * W * rr
    r = W * s
    d.ellipse([px-r, py-r, px+r, py+r], fill=col + (230,))

# 中心闪电：外发光 + 渐变主体
bolt_w, bolt_h = W*0.30, W*0.42
bx0, by0 = int(cx-bolt_w*0.8), int(cy-bolt_h*0.7)
bx1, by1 = int(cx+bolt_w*0.8), int(cy+bolt_h*0.7)
bcx, bcy = (bx0+bx1)/2, (by0+by1)/2
poly = bolt_poly(bcx, bcy, bolt_w, bolt_h)

glow = Image.new('RGBA', (W, W), (0,0,0,0))
ImageDraw.Draw(glow).polygon(poly, fill=C_ORANGE + (160,))
glow = glow.filter(ImageFilter.GaussianBlur(W*0.02))
img = Image.alpha_composite(img, glow)

grad_im, grad_mask, pos = vgrad(lambda md: md.polygon([(x-bx0, y-by0) for x, y in poly], fill=255),
                                (bx0, by0, bx1, by1), (255, 214, 170), C_PINK)
img.paste(grad_im, pos, grad_mask)

img = img.resize((S, S), Image.LANCZOS)
img.save(os.path.join(OUT, 'icon.png'))
print('icon.png', img.size)

# ============ 状态栏模板图标（单色黑 + 透明，macOS template） ============
TS = 88  # 22pt @4x，足够清晰
TW = TS * SS
timg = Image.new('RGBA', (TW, TW), (0, 0, 0, 0))
td = ImageDraw.Draw(timg)
tpoly = bolt_poly(TW/2, TW/2, TW*0.56, TW*0.78)
td.polygon(tpoly, fill=(0, 0, 0, 255))
timg = timg.resize((TS, TS), Image.LANCZOS)
# 裁掉透明边距到内容 bbox + 留 6% 边距
bbox = timg.getbbox()
if bbox:
    timg = timg.crop(bbox)
    side = int(max(timg.width, timg.height) * 1.12)
    canvas = Image.new('RGBA', (side, side), (0,0,0,0))
    canvas.paste(timg, ((side-timg.width)//2, (side-timg.height)//2), timg)
    timg = canvas.resize((44, 44), Image.LANCZOS)
timg.save(os.path.join(OUT, 'tray.png'))
print('tray.png', timg.size)

# ============ Windows 托盘图标（彩色——黑闪电在 Windows 深色任务栏上会隐形） ============
WS = 64
WW = WS * SS
wimg = Image.new('RGBA', (WW, WW), (0, 0, 0, 0))
# 外发光描边（深橙描边保证浅色任务栏也看得清）
wpoly = bolt_poly(WW/2, WW/2, WW*0.56, WW*0.78)
gloww = Image.new('RGBA', (WW, WW), (0,0,0,0))
ImageDraw.Draw(gloww).polygon(wpoly, fill=(200, 80, 30, 255))
gloww = gloww.filter(ImageFilter.GaussianBlur(WW*0.02))
wimg = Image.alpha_composite(wimg, gloww)
wg, wm, wpos = vgrad(lambda md: md.polygon([(x-0, y-0) for x, y in wpoly], fill=255),
                     (0, 0, WW, WW), (255, 160, 110), C_PINK)
wimg.paste(wg, wpos, wm)
wimg = wimg.resize((WS, WS), Image.LANCZOS)
bbox = wimg.getbbox()
if bbox:
    wimg = wimg.crop(bbox)
    side = int(max(wimg.width, wimg.height) * 1.08)
    canvas = Image.new('RGBA', (side, side), (0,0,0,0))
    canvas.paste(wimg, ((side-wimg.width)//2, (side-wimg.height)//2), wimg)
    wimg = canvas.resize((32, 32), Image.LANCZOS)
wimg.save(os.path.join(OUT, 'tray-win.png'))
print('tray-win.png', wimg.size)
