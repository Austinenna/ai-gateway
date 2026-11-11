# aigateway 字标

2026-11-11 定稿（选型过程见 `/Users/enna/Projects/outputs/2026-11-11-ai-gateway-logo/wordmark.html` 里的 F9）。

| 文件 | 用途 |
| --- | --- |
| `aigateway-wordmark.svg` | 正式字标，字形已转成路径，不依赖字体；终点节点闪烁动画写在 SVG 里，开启“减少动态效果”时停住 |
| `aigateway-wordmark@2x.png` | 静态图（节点亮着），透明底，1334×260 |
| `make_svg.py` | 生成 SVG 的脚本 |

控制台用的是 `web/src/cr/aigateway-wordmark.svg`，内容和这里的 SVG 相同；改字标时两处一起更新。

## 构成

- 字：JetBrains Mono ExtraBold（800），`aigateway` 全小写，字距 -0.02em。
- 颜色：`ai` 信号绿 `#5cff9d`，`gateway` 奶白 `#edeae2`。
- 信号线：从 `a` 中间那道横笔里出发，位置和粗细与横笔一致（横笔顶在字高 0.531em，厚 0.085em），向右穿过 `gateway`，伸进终点方块节点。
- 层次：`gateway` 在最下，线压在 `gateway` 上（滤色混合），`ai` 压在线上，节点在最上。
- 明暗：整个字标从左往右由暗变亮（透明度 20% → 28% 处 72% → 65% 处全亮）。
- 节点：1.1 秒一次亮灭，直接切换不渐变，像终端光标。
- 只用在深色底上。

## 使用

画布四周留了发光的余量：左侧 0.5em、右侧约 0.65em（节点之外）、上下各 0.15em。按字号 `f` 放置时，高度设为 `1.3 × f`，左外边距 `-0.5 × f`，字母就和左边对齐。

## 重新生成

```bash
curl -L -o JetBrainsMono-ExtraBold.ttf https://github.com/JetBrains/JetBrainsMono/raw/master/fonts/ttf/JetBrainsMono-ExtraBold.ttf
pip install fonttools
python make_svg.py JetBrainsMono-ExtraBold.ttf aigateway-wordmark.svg
```
