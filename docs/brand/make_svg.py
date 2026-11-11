"""Generate the F9 aigateway wordmark as a self-contained SVG (glyphs outlined).

Geometry mirrors the CSS prototype (em = 1000 units):
box = padding .15em top/bottom, .5em left, .95em right; text at line-height 1.
"""
import sys
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

font_path, out_path = sys.argv[1], sys.argv[2]
font = TTFont(font_path)
gs = font.getGlyphSet()
cmap = font.getBestCmap()
hmtx = font['hmtx']

EM = 1000
LS = -20                      # letter-spacing -.02em
PAD_T, PAD_L, PAD_R = 150, 500, 950
asc, desc = font['hhea'].ascent, -font['hhea'].descent
BASE = PAD_T + (EM - (asc + desc)) / 2 + asc   # baseline y with line-height 1

def glyph_path(ch, x):
    pen = SVGPathPen(gs, ntos=lambda v: ('%.1f' % v).rstrip('0').rstrip('.'))
    gs[cmap[ord(ch)]].draw(TransformPen(pen, (1, 0, 0, -1, x, BASE)))
    return pen.getCommands()

x = PAD_L
ai, gw = [], []
for i, ch in enumerate('aigateway'):
    (ai if i < 2 else gw).append(glyph_path(ch, x))
    x += hmtx[cmap[ord(ch)]][0] + LS
W = round(x + PAD_R)
H = PAD_T * 2 + EM

BAR_Y = PAD_T + 531           # a's crossbar top, measured
BAR_H = 85
line_x0, line_x1 = 720, W - 400
node = 200
node_x, node_y = W - 300 - node, BAR_Y + BAR_H / 2 - node / 2

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W / 10:g}" height="{H / 10:g}" role="img" aria-label="aigateway">
  <title>aigateway</title>
  <style>
    .node {{ animation: blink 1.1s steps(1) infinite; }}
    @keyframes blink {{ 50% {{ opacity: 0; }} }}
    @media (prefers-reduced-motion: reduce) {{ .node {{ animation: none; }} }}
  </style>
  <defs>
    <linearGradient id="fade" x1="0" x2="{W}" y1="0" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#fff" stop-opacity=".2"/>
      <stop offset=".28" stop-color="#fff" stop-opacity=".72"/>
      <stop offset=".65" stop-color="#fff"/>
    </linearGradient>
    <mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="{W}" height="{H}">
      <rect width="{W}" height="{H}" fill="url(#fade)"/>
    </mask>
    <filter id="g-line" x="-5%" y="-300%" width="110%" height="700%"><feGaussianBlur stdDeviation="100" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <filter id="g-node" x="-150%" y="-150%" width="400%" height="400%"><feGaussianBlur stdDeviation="133" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <filter id="g-ai" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="150"/><feComponentTransfer><feFuncA type="linear" slope=".4"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <g mask="url(#m)">
    <path fill="#edeae2" d="{' '.join(gw)}"/>
    <rect x="{line_x0}" y="{BAR_Y}" width="{line_x1 - line_x0}" height="{BAR_H}" fill="#5cff9d" filter="url(#g-line)" style="mix-blend-mode:screen"/>
    <path fill="#5cff9d" filter="url(#g-ai)" d="{' '.join(ai)}"/>
    <rect class="node" x="{node_x:g}" y="{node_y:g}" width="{node}" height="{node}" fill="#5cff9d" filter="url(#g-node)"/>
  </g>
</svg>
'''
open(out_path, 'w').write(svg)
print(W, H, 'baseline', BASE)
