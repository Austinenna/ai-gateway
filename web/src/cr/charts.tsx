import { useEffect, useRef, useState } from 'react';

/** useSize tracks an element's box so SVG charts can fill their panel. */
export function useSize<T extends HTMLElement | SVGElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) }));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

/** useWidth tracks an element's width so SVG charts can draw in real pixels. */
export function useWidth<T extends HTMLElement | SVGElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export function Sparkline({ values, color = 'var(--go)' }: { values: number[]; color?: string }) {
  const [ref, w] = useWidth<SVGSVGElement>();
  const h = 26;
  const max = Math.max(...values, 1),
    min = Math.min(...values, 0);
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * w},${h - 2 - ((v - min) / (max - min || 1)) * (h - 4)}`);
  return (
    <svg ref={ref} className="sp" viewBox={`0 0 ${w || 1} ${h}`} aria-hidden="true">
      {w > 0 && values.length > 1 && <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth={1.2} />}
    </svg>
  );
}

/** Segments draws the 20-cell meter used across the console. */
export function Segments({ ratio, tone = 'on', cells = 20 }: { ratio: number; tone?: 'on' | 'am' | 'rd'; cells?: number }) {
  const lit = Math.round(Math.max(0, Math.min(1, ratio)) * cells);
  return (
    <div className="seg" aria-hidden="true">
      {Array.from({ length: cells }, (_, i) => (
        <i key={i} className={i < lit ? tone : ''} />
      ))}
    </div>
  );
}

export type Bucket = { started: number; ok: number; failed: number; ttft: number | null };

/** Throughput is the step chart of successful calls with failure bars and a TTFT line. */
export function Throughput({ buckets, onHover }: { buckets: Bucket[]; onHover?: (text: string | null, x: number, y: number) => void }) {
  const [ref, size] = useSize<SVGSVGElement>();
  const W = size.w,
    H = Math.max(200, size.h || 250),
    pl = 34,
    pr = 40,
    pt = 12,
    pb = 22;
  if (!buckets.length) return <svg ref={ref} id="thru" />;
  const maxReq = Math.max(4, ...buckets.map((b) => b.ok + b.failed));
  const step = Math.pow(10, Math.floor(Math.log10(maxReq)));
  const max = Math.ceil(maxReq / step) * step;
  const hasTTFT = buckets.some((b) => b.ttft != null);
  const maxT = Math.max(1, ...buckets.map((b) => (b.ttft || 0) / 1000)) * 1.15;
  const iw = (W - pl - pr) / buckets.length,
    ih = H - pt - pb;
  const y = (v: number) => H - pb - (v / max) * ih;
  let area = `M${pl},${H - pb}`,
    line = '';
  buckets.forEach((b, i) => {
    const yy = y(b.ok);
    area += `L${pl + i * iw},${yy}L${pl + (i + 1) * iw},${yy}`;
    line += (i ? 'L' : 'M') + `${pl + i * iw},${yy}L${pl + (i + 1) * iw},${yy}`;
  });
  area += `L${pl + buckets.length * iw},${H - pb}Z`;
  const ttftPts = buckets
    .map((b, i) => (b.ttft == null ? null : `${pl + (i + 0.5) * iw},${pt + ih * (1 - b.ttft / 1000 / maxT)}`))
    .filter(Boolean) as string[];
  // Short windows need seconds to tell buckets apart; long windows need the date.
  const span = buckets.length > 1 ? buckets[buckets.length - 1].started - buckets[0].started : 0;
  const label = (t: number) =>
    span > 2 * 86400e3
      ? new Date(t).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit' })
      : new Date(t).toLocaleTimeString('zh-CN', span < 3600e3 ? { hour12: false } : { hour12: false, hour: '2-digit', minute: '2-digit' });
  const worst = buckets.reduce((a, b, i) => (b.failed > buckets[a].failed ? i : a), 0);
  return (
    <svg ref={ref} id="thru" viewBox={`0 0 ${W || 1} ${H}`} role="img" aria-label="每个时段的成功与失败调用数">
      {W > 0 && (
        <>
          <defs>
            <linearGradient id="cr-gg" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="var(--go)" stopOpacity=".35" />
              <stop offset="1" stopColor="var(--go)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {Array.from({ length: 5 }, (_, i) => {
            const yy = pt + (ih * i) / 4;
            return (
              <g key={i}>
                <line x1={pl} x2={W - pr} y1={yy} y2={yy} stroke="var(--line)" />
                <text x={pl - 6} y={yy + 3} textAnchor="end" fontSize={9.5} fill="var(--dim)">
                  {Math.round(max * (1 - i / 4))}
                </text>
                {hasTTFT && (
                  <text x={W - pr + 6} y={yy + 3} fontSize={9.5} fill="var(--cyan)">
                    {(maxT * (1 - i / 4)).toFixed(1)}s
                  </text>
                )}
              </g>
            );
          })}
          {buckets.map((_, i) => (
            <line key={i} x1={pl + i * iw} x2={pl + i * iw} y1={pt} y2={H - pb} stroke="var(--line)" strokeWidth={i % 6 ? 0.5 : 1} />
          ))}
          <path d={area} fill="url(#cr-gg)" />
          <path d={line} fill="none" stroke="var(--go)" strokeWidth={1.5} style={{ filter: 'drop-shadow(0 0 4px rgba(92,255,157,.6))' }} />
          {buckets.map((b, i) =>
            b.failed ? (
              <rect
                key={'f' + i}
                x={pl + i * iw + 2}
                y={y(b.failed)}
                width={Math.max(1, iw - 4)}
                height={H - pb - y(b.failed)}
                fill="var(--red)"
              />
            ) : null,
          )}
          {ttftPts.map((pt, i) => {
            const [cx, cy] = pt.split(',');
            return <circle key={'t' + i} cx={cx} cy={cy} r={2} fill="var(--cyan)" pointerEvents="none" />;
          })}
          {ttftPts.length > 1 && (
            <polyline
              points={ttftPts.join(' ')}
              fill="none"
              stroke="var(--cyan)"
              strokeWidth={1}
              strokeDasharray="3 2"
              pointerEvents="none"
            />
          )}
          {buckets[worst].failed > 0 && (
            <g>
              <line
                x1={pl + (worst + 0.5) * iw}
                x2={pl + (worst + 0.5) * iw}
                y1={pt}
                y2={H - pb}
                stroke="var(--red)"
                strokeDasharray="2 3"
              />
              <text x={pl + (worst + 0.5) * iw + 6} y={pt + 12} fontSize={10} fill="var(--red)">
                ▲ {label(buckets[worst].started)} FAIL ×{buckets[worst].failed}
              </text>
            </g>
          )}
          {buckets.map((b, i) => (
            <g key={'h' + i}>
              <rect
                x={pl + i * iw}
                y={pt}
                width={iw}
                height={ih}
                fill="transparent"
                onMouseMove={(e) =>
                  onHover?.(
                    `${label(b.started)}  OK ${b.ok}  FAIL ${b.failed}  TTFT ${b.ttft == null ? '—' : (b.ttft / 1000).toFixed(2) + 's'}`,
                    e.clientX,
                    e.clientY,
                  )
                }
                onMouseLeave={() => onHover?.(null, 0, 0)}
              />
              {i % Math.max(1, Math.round(buckets.length / 8)) === 0 && (
                <text x={pl + i * iw + 2} y={H - 6} fontSize={9.5} fill="var(--dim)">
                  {label(b.started)}
                </text>
              )}
            </g>
          ))}
        </>
      )}
    </svg>
  );
}

/** TtftHistogram draws the window's first-token latency distribution (200 ms bins, last bin ≥ 5 s). */
export function TtftHistogram({ counts, p50, p95 }: { counts: number[]; p50: number | null; p95: number | null }) {
  const [ref, size] = useSize<SVGSVGElement>();
  const W = size.w,
    H = Math.max(140, size.h || 160);
  const binMs = 200,
    bins = counts.length || 26,
    pl = 30,
    pb = 18,
    pt = 14;
  const mx = Math.max(1, ...counts);
  const step = Math.max(1, Math.ceil(mx / 3));
  const top = step * 3;
  const bw = (W - pl) / bins;
  const y = (v: number) => H - pb - (v / top) * (H - pb - pt);
  const xOf = (ms: number) => pl + (Math.min(ms, bins * binMs) / binMs) * bw;
  const p95Bin = p95 == null ? bins : Math.floor(p95 / binMs);
  return (
    <svg ref={ref} id="hist" viewBox={`0 0 ${W || 1} ${H}`} role="img" aria-label="首个 token 耗时分布">
      {W > 0 &&
        [0, 1, 2, 3].map((k) => (
          <g key={'y' + k}>
            <line x1={pl} x2={W} y1={y(step * k)} y2={y(step * k)} stroke="var(--line)" />
            <text x={pl - 6} y={y(step * k) + 3} textAnchor="end" fontSize={9.5} fill="var(--dim)">
              {step * k}
            </text>
          </g>
        ))}
      {W > 0 &&
        counts.map((c, i) => {
          const hot = p50 != null && Math.floor(p50 / binMs) === i;
          const slow = i > p95Bin || i === bins - 1;
          return (
            <rect
              key={i}
              x={pl + i * bw + 1}
              y={y(c)}
              width={Math.max(1, bw - 2)}
              height={H - pb - y(c)}
              fill={hot ? 'var(--go)' : slow ? 'var(--amber)' : 'var(--go-2)'}
            >
              <title>{`${i === bins - 1 ? '≥5s' : (i * binMs) / 1000 + '–' + ((i + 1) * binMs) / 1000 + 's'} · ${c} 次`}</title>
            </rect>
          );
        })}
      {W > 0 &&
        [0, 1, 2, 3, 4].map((sec) => (
          <text key={'x' + sec} x={xOf(sec * 1000)} y={H - 4} fontSize={9.5} fill="var(--dim)">
            {sec}s
          </text>
        ))}
      {W > 0 && (
        <text x={W - 2} y={H - 4} fontSize={9.5} fill="var(--amber)" textAnchor="end">
          ≥5s
        </text>
      )}
      {W > 0 &&
        (
          [
            [p50, 'p50'],
            [p95, 'p95'],
          ] as const
        ).map(([v, l]) =>
          v == null ? null : (
            <g key={l}>
              <line x1={xOf(v)} x2={xOf(v)} y1={pt - 4} y2={H - pb} stroke="var(--tx-2)" strokeDasharray="2 2" />
              <text x={Math.min(xOf(v) + 4, W - 60)} y={pt - 4 + (l === 'p95' ? 12 : 0)} fontSize={9.5} fill="var(--tx-2)">
                {l} {(v / 1000).toFixed(2)}s
              </text>
            </g>
          ),
        )}
    </svg>
  );
}
