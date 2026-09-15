"""Build the project explanation report. Uses ReportLab; no live gateway access."""
from pathlib import Path
from html import escape
import math
import re

from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, Flowable
from reportlab.graphics.shapes import Drawing, Rect, Line, String, Polygon

ROOT = Path(__file__).resolve().parents[2]
PDF = ROOT / 'output/pdf/local-ai-gateway-report.pdf'
MD = ROOT / 'docs/project-understanding-report.md'
PDF.parent.mkdir(parents=True, exist_ok=True)

pdfmetrics.registerFont(TTFont('CN', '/System/Library/Fonts/STHeiti Light.ttc', subfontIndex=0))
pdfmetrics.registerFont(TTFont('CN-Bold', '/System/Library/Fonts/STHeiti Medium.ttc', subfontIndex=0))
pdfmetrics.registerFontFamily('CN', normal='CN', bold='CN-Bold', italic='CN', boldItalic='CN-Bold')

INK = colors.HexColor('#193044')
MUTED = colors.HexColor('#536778')
BLUE = colors.HexColor('#216FA0')
TEAL = colors.HexColor('#287B77')
LINE = colors.HexColor('#CAD7DF')
PALE = colors.HexColor('#F0F5F8')
LIGHT = colors.HexColor('#E9F4F0')
AMBER = colors.HexColor('#896031')
W = 507.2756

styles = {
    'body': ParagraphStyle('body', fontName='CN', fontSize=10.3, leading=16.6, textColor=INK, wordWrap='CJK', spaceAfter=8),
    'lead': ParagraphStyle('lead', fontName='CN', fontSize=11.5, leading=19, textColor=INK, wordWrap='CJK', spaceAfter=13),
    'title': ParagraphStyle('title', fontName='CN-Bold', fontSize=24, leading=32, textColor=INK, spaceAfter=13, wordWrap='CJK'),
    'sub': ParagraphStyle('sub', fontName='CN-Bold', fontSize=12.2, leading=19, textColor=BLUE, spaceBefore=9, spaceAfter=6, wordWrap='CJK'),
    'caption': ParagraphStyle('caption', fontName='CN', fontSize=8.5, leading=13, textColor=MUTED, spaceBefore=4, spaceAfter=11, wordWrap='CJK'),
    'source': ParagraphStyle('source', fontName='CN', fontSize=8, leading=12, textColor=MUTED, spaceBefore=8, spaceAfter=0, wordWrap='CJK'),
    'cell': ParagraphStyle('cell', fontName='CN', fontSize=9.3, leading=14.4, textColor=INK, wordWrap='CJK'),
    'th': ParagraphStyle('th', fontName='CN-Bold', fontSize=9.3, leading=14.4, textColor=INK, wordWrap='CJK'),
}
story = []
markdown = ['# 本地 AI 网关｜项目理解报告', '', '> 2026-09-15 · 基于当前源码与项目文档 · 面向项目所有者', '',
            '本报告使用 explain-project 的逐层讲解方法，从用途、对象和正常流程进入实现与边界。历史测试结果明确标注日期；本轮未运行业务测试或调用真实厂商。', '']
sections = []
diagram_count = 0

def rich(text):
    text = escape(text)
    text = re.sub(r'\*\*(.*?)\*\*', r'<b>\1</b>', text)
    return text.replace('\n', '<br/>')

def p(text, kind='body'):
    story.append(Paragraph(rich(text), styles[kind]))
    markdown.extend([text, ''])

def h(text):
    story.append(Paragraph(rich(text), styles['sub']))
    markdown.extend(['### ' + text, ''])

def section(number, title, lead):
    if sections:
        story.append(PageBreak())
    sections.append(title)
    story.append(Paragraph(f'{number:02d} / 项目理解', styles['caption']))
    story.append(Paragraph(title, styles['title']))
    markdown.extend([f'## {number}. {title}', ''])
    p(lead, 'lead')

def table(headers, rows, widths):
    data = [[Paragraph(rich(v), styles['th']) for v in headers]]
    data += [[Paragraph(rich(v), styles['cell']) for v in row] for row in rows]
    t = Table(data, colWidths=[W*x/sum(widths) for x in widths], hAlign='LEFT', repeatRows=1)
    t.setStyle(TableStyle([
        ('VALIGN', (0,0), (-1,-1), 'TOP'),
        ('BACKGROUND', (0,0), (-1,0), PALE),
        ('LINEBELOW', (0,0), (-1,0), 0.8, LINE),
        ('LINEBELOW', (0,1), (-1,-1), 0.35, LINE),
        ('LEFTPADDING', (0,0), (-1,-1), 9), ('RIGHTPADDING', (0,0), (-1,-1), 9),
        ('TOPPADDING', (0,0), (-1,-1), 8), ('BOTTOMPADDING', (0,0), (-1,-1), 8),
    ]))
    story.extend([t, Spacer(1,8)])
    clean = lambda s: s.replace('\n','<br>').replace('|','／')
    markdown.append('| '+' | '.join(map(clean, headers))+' |')
    markdown.append('| '+' | '.join(['---']*len(headers))+' |')
    markdown.extend('| '+' | '.join(map(clean,row))+' |' for row in rows)
    markdown.append('')

def source(text):
    story.append(Paragraph(rich('依据：'+text), styles['source']))
    markdown.extend(['*依据：'+text+'*', ''])

def label(d, x, y, text, size=9.5, color=INK, anchor='middle', bold=False):
    d.add(String(x,y,text,fontName='CN-Bold' if bold else 'CN',fontSize=size,fillColor=color,textAnchor=anchor))

def box(d,x,y,w,h,title,subtitle='',fill=PALE):
    d.add(Rect(x,y,w,h,rx=5,ry=5,fillColor=fill,strokeColor=LINE,strokeWidth=.6))
    if subtitle:
        label(d,x+w/2,y+h/2+4,title,10,bold=True)
        label(d,x+w/2,y+h/2-12,subtitle,8.6,MUTED)
    else:
        label(d,x+w/2,y+h/2-3,title,10,bold=True)

def arrow(d,x1,y1,x2,y2,color=BLUE,dashed=False):
    line=Line(x1,y1,x2,y2,strokeColor=color,strokeWidth=1)
    if dashed: line.strokeDashArray=[3,3]
    d.add(line)
    angle=math.atan2(y2-y1,x2-x1)
    size=5
    pts=[x2,y2,x2-size*math.cos(angle-.48),y2-size*math.sin(angle-.48),x2-size*math.cos(angle+.48),y2-size*math.sin(angle+.48)]
    d.add(Polygon(pts,fillColor=color,strokeColor=color,strokeWidth=.4))

def fig(d,caption,mermaid):
    global diagram_count
    diagram_count += 1
    story.extend([Spacer(1,3),d,Paragraph(rich(f'图 {diagram_count}  {caption}'),styles['caption'])])
    markdown.extend(['```mermaid',mermaid.strip(),'```','',f'*图 {diagram_count}  {caption}*',''])

section(1,'一个入口，管理自己的模型调用',
        '**本地 AI 网关供自己的程序和 AI Agent 共用：集中保管厂商凭据，按项目开放模型，并留下可检查的通信记录。**')
p('例如，代码助手和写作工具各有一个项目身份。你在网关配置可用模型，再把网关地址、对应的项目凭证和模型别名填进工具。之后工具提交消息，网关调用厂商并返回回答，你通过管理页面检查过程。')
p('“本地”指网关运行在自己的电脑上。真实推理由已配置的厂商完成；内置演示模型只返回固定说明文字，用来验证接入流程。')
d=Drawing(W,169)
box(d,0,93,139,58,'自己的程序 / Agent','代码助手、写作工具')
box(d,185,93,139,58,'本地 AI 网关','权限、转发、记录',LIGHT)
box(d,369,93,138,58,'厂商模型','智谱 / MiniMax')
arrow(d,139,132,185,132);label(d,162,143,'请求',8.4)
arrow(d,324,132,369,132);label(d,347,143,'调用',8.4)
arrow(d,369,108,324,108,TEAL);label(d,347,94,'响应',8.4)
arrow(d,185,108,139,108,TEAL);label(d,162,94,'回答',8.4)
box(d,185,0,139,47,'浏览器管理页面','配置与查看记录')
arrow(d,242,47,242,93);arrow(d,267,93,267,47,TEAL)
fig(d,'日常调用与管理入口：程序发消息，你管理配置和查看结果。', '''flowchart LR
  A[自己的程序 / Agent] -->|请求| B[本地 AI 网关]
  B -->|调用| C[厂商模型]
  C -->|响应| B
  B -->|回答| A
  D[浏览器管理页面] -->|配置| B
  B -->|记录| D''')
h('这个项目带来的三项直接收益')
table(['收益','具体变化'],[
    ['凭据集中保管','厂商 Token 保存于网关；各个程序使用独立的项目 Token。'],
    ['模型配置集中调整','程序使用固定别名；保持协议兼容时，可以在网关更换实际模型。'],
    ['模型通信可检查','能查看已记录调用的消息、完整返回字段或流式事件，以及耗时和状态。'],
],[1,3.5])
p('**当前定位：核心流程已实现、经模拟环境验证的个人 LLM 网关 Demo。** 首版聚焦大语言模型。语音、视频、自动选模型、跨厂商回退和费用预算尚未进入当前流程。')
source('README.md §2、§9；docs/demo.md §已实现的流程；proxy.go:426。源码路径见第 8 页。')

section(2,'四个对象，组成一套配置关系',
        '**连接决定去哪里，模型决定调用什么，项目决定谁能用，请求记录保存发生了什么。**')
table(['对象','作用与边界'],[
    ['厂商连接','保存厂商、接口格式、基础地址、加密凭据和启用状态。同一厂商可以配置多条连接。'],
    ['模型配置','把程序使用的别名映射到连接和真实模型 ID，并提供默认参数。'],
    ['项目','代表一个调用方，拥有自己的 Token 和模型授权；不自动绑定目录或仓库。'],
    ['请求记录','保存一次调用的身份、模型、内容、耗时与状态快照。'],
],[1,4])
d=Drawing(W,147)
label(d,73,135,'调用身份',9,BLUE,bold=True)
label(d,254,135,'模型别名',9,BLUE,bold=True)
label(d,434,135,'厂商连接',9,BLUE,bold=True)
box(d,4,77,138,42,'项目 A：代码助手')
box(d,4,9,138,42,'项目 B：写作工具')
box(d,185,77,138,42,'coding')
box(d,185,9,138,42,'fast')
box(d,365,43,138,50,'智谱主连接','地址与厂商 Token')
arrow(d,142,98,185,98);arrow(d,142,89,185,39);arrow(d,142,30,185,30)
arrow(d,323,98,365,81);arrow(d,323,30,365,57)
fig(d,'配置关系示例。A 可用 coding 与 fast，B 只能用 fast；两个模型可共用连接。', '''flowchart LR
  PA[项目 A：代码助手] -->|授权| M1[coding]
  PA -->|授权| M2[fast]
  PB[项目 B：写作工具] -->|授权| M2
  M1 --> C[智谱主连接]
  M2 --> C''')
h('模型名称为什么分开保存')
table(['字段','例子 / 用途','修改后的影响'],[
    ['显示名称','我的代码模型','只影响管理页面。'],
    ['调用别名','coding','程序填写的 model；改名需同步修改程序。'],
    ['厂商模型 ID','账号实际开通的模型 ID','决定厂商运行哪个模型；保留别名时，后续请求使用新模型。'],
    ['内部 ID','数据库中的固定身份','项目授权引用它；常规编辑不更换这个身份。'],
],[1,1.55,2.45])
p('一个模型可以授权给多个项目，一个项目也可以拥有多个模型。若两个程序共用同一个项目 Token，网关会将它们视为同一调用身份。')
source('store.go:23、:166；admin.go:163、:223；proxy.go:41、:73。')

section(3,'从配置到调用：先准备，再使用',
        '**配置完成后，程序直接调用网关，不必每次经过管理页面。** 服务需要处于已解锁状态，才能取出厂商凭据。')
p('准备顺序：创建连接并填入厂商 Token → 创建模型映射 → 创建项目并勾选模型 → 复制接入信息到程序。Chat Completions 客户端填写网关的 /v1 基础地址、完整项目 Token 和模型别名。')
d=Drawing(W,258)
xs=[67,253,439]
for x,title in zip(xs,['项目程序','网关','厂商模型']):
    box(d,x-53,223,106,30,title)
    line=Line(x,8,x,220,strokeColor=LINE,strokeWidth=.8);line.strokeDashArray=[3,3];d.add(line)
arrow(d,67,196,253,196);label(d,160,204,'1. 凭证 + coding + 消息',8.7)
box(d,173,145,160,34,'2. 识别项目、检查授权',fill=LIGHT)
box(d,173,94,160,34,'3. 映射模型、加入厂商凭据',fill=LIGHT)
arrow(d,253,73,439,73);label(d,346,81,'4. 发送厂商请求',8.7)
arrow(d,439,47,253,47,TEAL);label(d,346,55,'5. 返回 JSON / 流式事件',8.7)
arrow(d,253,21,67,21,TEAL);label(d,160,29,'6. 返回内容；结束时提交记录',8.7)
fig(d,'一次成功请求的执行顺序。图中省略重复的配置读取与网络细节。', '''sequenceDiagram
  participant P as 项目程序
  participant G as 网关
  participant V as 厂商模型
  P->>G: 项目 Token + coding + 消息
  Note over G: 识别项目；检查模型授权、启用状态与协议
  Note over G: 解密厂商凭据；补默认参数；替换模型 ID
  G->>V: 请求真实模型
  V-->>G: JSON 或 SSE 事件
  G-->>P: 返回内容
  Note over G: 结束时提交调用记录''')
h('网关在中间做了哪些改变')
table(['处理','实际规则'],[
    ['身份与路由','凭证确定项目；别名确定模型；授权和启用状态均从服务端查询。'],
    ['请求内容','移除客户端顶层路由、鉴权字段；保留工具及其他业务字段；替换真实模型 ID。'],
    ['默认参数','只补客户端未提供的值。目前可配置 temperature 与 max_tokens，属于缺省值，不是强制额度。'],
    ['厂商鉴权','用已配置连接的厂商 Token 发送请求；不把项目 Token 当作厂商凭据。'],
],[1,4])
p('页面有两种测试：**模型测试**使用管理员身份，不检查项目授权；**项目试调用**使用项目 Token，经过完整权限检查。前者成功，不能替代后者的验证。')
source('proxy.go:90、:126、:176；http.go:180；web/src/main.tsx:117。')

section(4,'协议、流式输出与工具调用',
        '**接口协议约定请求和响应的格式。** 当前按相同协议转发，客户端入口必须与模型连接的协议一致。')
table(['客户端入口','用途','网关的处理'],[
    ['GET /v1/models','列出可用模型','本地查询该项目已获授权且启用的模型别名。'],
    ['POST /v1/\nchat/completions','Chat Completions 调用','连接地址追加 /chat/completions。'],
    ['POST /v1/messages','Messages 调用','连接地址追加 /messages。'],
],[1.7,1.3,2])
p('智谱连接当前使用 Chat Completions；MiniMax 可选 Chat Completions 或 Messages。尚未实现 Responses、Token Counting 和任意协议互转。Messages 客户端按其 SDK 规则填写网关根地址，由 SDK 补上接口路径。')
h('普通返回与流式返回')
p('普通调用先收齐完整响应，再返回客户端。流式调用采用 SSE，也就是连续发送的事件；网关收到一个完整事件就转发并刷新输出。')
d=Drawing(W,117)
label(d,4,97,'普通',9.5,BLUE,'start',True)
box(d,65,74,181,38,'收齐厂商完整响应')
box(d,321,74,181,38,'一次返回客户端')
arrow(d,246,93,321,93)
label(d,4,34,'流式',9.5,BLUE,'start',True)
for x,n in [(65,1),(219,2),(373,3)]:
    box(d,x,9,129,43,f'事件 {n} 到达',f'立即转发事件 {n}',LIGHT)
arrow(d,194,30,219,30);arrow(d,348,30,373,30)
fig(d,'返回方式示意，横向间距不代表实际耗时。客户端取消会传递给上游。', '''flowchart LR
  A[普通：收齐完整响应] --> B[一次返回]
  C[流式：事件 1 到达并转发] --> D[事件 2 到达并转发] --> E[事件 3 到达并转发]''')
h('Agent 执行工具，网关转发工具内容')
p('例如模型要求读取一个文件：模型返回工具调用 → 网关转给 Agent → Agent 读取文件 → Agent 把结果连同上下文发起下一次请求。工具定义、工具调用、工具结果和相关内容块在已支持协议中保留。')
p('**网关不自动执行工具，也不从历史记录补齐对话。** 多轮上下文由客户端维护。模型换成另一种协议时，仅保留同一个别名不足以保证客户端继续兼容。')
source('http.go:181；admin.go:17；proxy.go:116、:207、:229、:265；docs/demo.md §真实模型配置。')

section(5,'内部结构：一个进程，一套数据',
        '**Go 服务同时提供管理页面和调用接口；SQLite 保存配置与记录。** 前端构建后嵌入可执行文件，日常运行无需另起 Node 服务。')
d=Drawing(W,205)
box(d,0,158,151,43,'浏览器管理页面','配置与记录查看')
box(d,356,158,151,43,'项目程序 / Agent','调用模型')
d.add(Rect(0,25,W,108,rx=6,ry=6,fillColor=colors.white,strokeColor=LINE,strokeWidth=.8))
label(d,12,116,'同一个 Go 服务',9.3,BLUE,'start',True)
box(d,14,45,141,48,'管理接口','登录、配置、查询')
box(d,183,45,141,48,'SQLite 数据库','配置、凭据、授权、记录',LIGHT)
box(d,352,45,141,48,'调用与转发','项目授权、厂商请求')
arrow(d,75,158,75,133);arrow(d,75,133,75,93)
arrow(d,432,158,432,133);arrow(d,432,133,432,93)
arrow(d,155,70,183,70);arrow(d,352,70,324,70)
label(d,253,6,'厂商请求由 Go 服务通过 HTTP 发出；数据库无需独立进程。',8.6,MUTED)
fig(d,'运行组成。图中按主要职责分区，不代表存在多个后端服务。', '''flowchart TD
  U[浏览器管理页面] --> A[管理接口]
  P[项目程序 / Agent] --> F[调用与转发]
  subgraph G[同一个 Go 服务]
    A --> D[(SQLite：配置、凭据、授权、记录)]
    F --> D
  end
  F <--> V[厂商 API]''')
h('从代码职责理解各部分')
table(['职责','主要文件'],[
    ['启动与接口入口','cmd/gateway/main.go；internal/gateway/http.go'],
    ['连接、模型和项目配置','internal/gateway/admin.go；delete.go'],
    ['模型转发与流式处理','internal/gateway/proxy.go'],
    ['数据库与凭据管理','store.go；project_credentials.go；local_unlock.go'],
    ['管理页面与接入信息','web/src/main.tsx；ProjectAccessContent.tsx；protocol.mjs'],
],[1.6,3.4])
h('配置删除怎样影响历史')
p('删除模型会同时移除它的项目授权；删除项目会让对应凭证失效。删除连接时，可确认关联模型后一起删除。历史请求保留当时的名称和内容快照，不随配置删除。')
p('关联删除使用数据库事务，相关操作一起成功或一起回滚。停用、撤权、重置和删除作用于后续请求，不保证立即中断已经开始的流式调用。')
source('main.go:24；web/embed.go；store.go:134、:166；delete.go；web/src/main.tsx:37。')

section(6,'三类凭据与网关的解锁状态',
        '**管理密码用于解锁，项目 Token 用于调用网关，厂商 Token 用于调用厂商。** 三者对应不同入口与权限。')
table(['凭据','使用者','能做什么'],[
    ['管理密码','你','建立管理会话、解锁主密钥；标准模式下再次验证后可查看厂商 Token。'],
    ['项目 Token','项目程序','调用获授权模型、列举自己的可用模型；无管理和历史检索权限。'],
    ['厂商 Token','网关服务','向所配置厂商进行鉴权；加密保存在连接中。'],
],[1,1,3])
p('主密钥是网关生成的随机加密密钥。标准模式下，它由管理密码派生出的密钥保护；解锁后进入内存，用来解密厂商凭据和项目 Token 的加密副本。')
d=Drawing(W,145)
box(d,0,93,141,44,'管理密码 + 随机盐')
box(d,183,93,141,44,'密码派生密钥','Argon2id')
box(d,366,93,141,44,'解锁主密钥','进入服务内存',LIGHT)
arrow(d,141,115,183,115);arrow(d,324,115,366,115)
box(d,93,5,151,46,'厂商 Token 密文','解密后调用厂商')
box(d,279,5,174,46,'项目 Token 加密副本','供管理员复制或试调用')
d.add(Line(436,93,436,79,strokeColor=BLUE,strokeWidth=1))
d.add(Line(169,79,436,79,strokeColor=BLUE,strokeWidth=1))
arrow(d,169,79,169,51);arrow(d,366,79,366,51)
label(d,256,63,'AES-256-GCM',8.6,MUTED)
fig(d,'标准模式的解锁关系。项目调用鉴权使用另存的摘要，不必先解密项目 Token。', '''flowchart TD
  A[管理密码 + 随机盐] -->|Argon2id| B[密码派生密钥]
  B -->|解开包裹| C[内存中的主密钥]
  C -->|AES-256-GCM| D[厂商 Token]
  C -->|AES-256-GCM| E[项目 Token 加密副本]''')
h('复制、重置与锁定分别意味着什么')
p('项目 Token 同时保存校验摘要和加密副本。复制原值不会改变调用配置；重置才会生成新值并使旧值失效。旧版只有摘要的项目无法反推原文，需要提交原有效 Token 补存，或明确重置。')
p('**解锁是整个服务的状态，登录是浏览器会话的状态。** 关闭页面不会主动锁定网关；点击锁定会清除主密钥和全部管理会话。服务重启后需要重新解锁，才能继续模型调用。')
h('当前临时本地模式')
p('启动脚本启用空白解锁开关。首次使用原密码激活后，可留空解锁，原密码仍保留。此模式只允许回环地址，管理入口不再依赖秘密密码；接口内的项目授权仍保留。数据库中的调用正文可读，凭据加密不等于整库加密。')
source('store.go:89、:230；http.go:51、:78；project_credentials.go；local_unlock.go；scripts/start.sh。')

section(7,'请求记录能解释什么',
        '**记录用于检查一次模型调用的内容、结果和耗时。** 当前保存的是经过整理与凭据脱敏的内容，不是字节级网络抓包。')
p('输入记录在补默认参数、替换真实模型 ID 之前生成。因此它能反映程序提交的业务内容，但不能直接代表最终发给厂商的完整请求体。输出记录保留返回 JSON 或整理后的 SSE 事件。')
d=Drawing(W,157)
box(d,0,98,141,47,'项目请求已整理','移除路由字段、脱敏')
box(d,183,98,141,47,'补参数、换模型 ID')
box(d,366,98,141,47,'请求厂商模型')
arrow(d,141,121,183,121);arrow(d,324,121,366,121)
box(d,0,6,141,43,'此处保存输入记录',fill=LIGHT)
arrow(d,70,98,70,49,TEAL)
box(d,183,6,324,43,'响应收集完成后 → 内存队列 → SQLite',fill=LIGHT)
arrow(d,436,98,436,49,TEAL)
label(d,265,65,'尚未另存最终上游请求体',8.7,AMBER)
fig(d,'记录位置决定了可以观察到什么；持久化列表通常在调用结束后才出现这条记录。', '''flowchart LR
  A[整理后的项目请求] --> B[补默认参数、替换模型 ID] --> C[厂商模型]
  A --> D[保存输入记录]
  C --> E[收集响应]
  E --> F[结束后进入内存队列] --> G[(SQLite)]''')
table(['内容或指标','当前含义 / 限制'],[
    ['记录范围','鉴权、解析、授权、协议检查、解锁或解密阶段被拒绝的请求，尚未建立记录。'],
    ['首字时间与总耗时','从转发准备阶段计时；首字取首个有效文本。非流式模式需等完整响应，不含全部前置处理。'],
    ['Token 用量','来自厂商返回；没有上报时，不能把显示的零值理解为准确的零消耗。'],
    ['容量与保留','请求体 2 MiB；普通响应 8 MiB；输入、输出记录各 1 MiB。列表最近 200 条，没有自动清理。'],
    ['写入可靠性','记录结束后尝试进入 32 条内存队列；队列满或写盘失败计入未写入数量，重启不保留该计数。'],
],[1.3,3.7])
p('**响应转发完成和记录完整保存是两个结果。** 超过记录大小上限会标记截断；SSE 单行或单事件触及约 1 MiB 保护上限时，还可能结束转发。已知凭据会被替换，但业务正文没有通用隐私脱敏。')
source('proxy.go:152、:176、:265；store.go:195、:354；admin.go:294；docs/demo.md §记录与性能边界。')

section(8,'当前阶段、阅读入口与后续方向',
        '**当前已完成基本业务流程，下一步最有价值的是取得真实使用证据。** 下面区分代码已实现、历史验证记录和仍待验证的部分。')
table(['层面','当前状态'],[
    ['业务流程','配置、授权、调用、记录、接入信息复制和关联删除均已实现。'],
    ['历史自动化验证','文档记载 2026-09-14：19 个 Go 集成测试含竞态检测、7 个前端单测、4 个常规浏览器测试及 1 个空白解锁测试通过。'],
    ['构建与运行环境','文档记载 macOS 与 Linux amd64 / arm64 已构建；真实 Linux 主机运行待验证。'],
    ['厂商与性能','真实厂商、套餐和 Agent 联调待验证；没有真实端到端延迟、吞吐、资源占用或网关开销基准。'],
],[1.15,3.85])
h('建议依次回答的三个实际问题')
p('**1. 真正的工具能否用起来？** 先选一个实际客户端和一个厂商模型，验证普通请求、流式输出、工具循环、项目权限和记录内容。')
p('**2. 现有记录是否足够排查？** 按实际需要决定是否补充脱敏后的最终上游请求体、前置失败记录和历史保留规则。以上均为建议，尚未实施。')
p('**3. 搬到 Linux 后能否保持体验？** 准备迁移时，再验证标准密码模式、正常停机的一致备份、服务启动方式和实际网络耗时。')
h('沿着调用链阅读源码')
p('阅读顺序：http.go 的接口入口 → proxy.go 的鉴权与转发 → store.go 的数据与解锁 → admin.go 和前端交互。')
table(['资料','用途'],[
    ['README.md；docs/demo.md','项目范围、操作步骤、限制与历史验证结果。'],
    ['docs/current-architecture.md','按源码核对的详细架构与实现说明。'],
    ['internal/gateway/；web/src/；web/tests/','后端、前端与测试。后端测试位于同目录的 *_test.go。'],
],[1.9,3.1])
p('**阅读说明**：路径均相对 local-ai-gateway 项目根目录，图中名称为示例。本轮只生成报告，测试结果引用历史记录；讲解顺序采用 explain-project 技能。', 'caption')

class ReportCanvas(canvas.Canvas):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        self.setTitle('本地 AI 网关｜项目理解报告')
        self.setAuthor('项目文档')
        self.setSubject('项目用途、对象关系、调用流程、权限与实现边界')

def page_decoration(c,doc):
    c.saveState()
    c.setStrokeColor(LINE);c.setLineWidth(.6)
    c.line(44,798,551,798);c.line(44,41,551,41)
    c.setFillColor(MUTED);c.setFont('CN',8)
    c.drawString(44,810,'LOCAL AI GATEWAY  /  项目理解报告')
    c.drawRightString(551,810,'2026-09-15')
    c.drawString(44,27,'文字说明 · 关系图 · 流程图 · 实现状态')
    c.drawRightString(551,27,f'{doc.page:02d} / 08')
    if 1 <= doc.page <= len(sections):
        c.bookmarkPage(f'section-{doc.page}')
        c.addOutlineEntry(sections[doc.page-1],f'section-{doc.page}',level=0)
    c.restoreState()

doc=SimpleDocTemplate(str(PDF),pagesize=(595.2756,841.8898),rightMargin=44,leftMargin=44,
                      topMargin=59,bottomMargin=53,pageCompression=1)
doc.build(story,onFirstPage=page_decoration,onLaterPages=page_decoration,canvasmaker=ReportCanvas)
MD.write_text('\n'.join(markdown),encoding='utf-8')
print(f'PDF: {PDF}\nMarkdown: {MD}\nFigures: {diagram_count}')
