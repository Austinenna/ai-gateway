import { type RequestRecord, firstTiming, inputTotal, outputTotal, number, percent, duration, dateTime, recordStatus, errorName } from './monitoring';

export function RequestHeader({ record: r }: { record: RequestRecord }) {
  return <header className="detail-head">
    <div className="detail-identity">
      <h2>{r.project_name}</h2>
      <span className={'result-label result-' + r.state}>{recordStatus(r)}</span>
      <time dateTime={new Date(r.started).toISOString()}>{dateTime(r.started)}</time>
    </div>
    <div className="detail-metadata">
      <span>模型 <code>{r.alias || '未路由'}</code></span>
      {r.connection_name && <span>连接 <b>{r.connection_name}</b></span>}
      <span className="detail-mode">{r.stream === true ? '流式' : r.stream === false ? '非流式' : '历史记录'}</span>
      <code className="detail-request-id" title={'请求 ID：' + r.id}>{r.id}</code>
    </div>
    {r.error_type && <div className="request-outcome-note">{errorName(r.error_type)} · HTTP {r.status || '—'}</div>}
    <RequestMetrics record={r}/>
  </header>;
}

export function RequestMetrics({ record: r }: { record: RequestRecord }) {
  const input = inputTotal(r), output = outputTotal(r);
  return <div className="detail-metric-grid">
    <div title="从开始转发到首段有效思考、正文或工具内容"><span>首个 Token · TTFT</span><b>{firstTiming(r)}</b></div>
    <div title="从开始转发到首段非空正文，不含思考和工具调用"><span>正文首字 · TTFC</span><b>{firstTiming(r, true)}</b></div>
    <div><span>总耗时</span><b>{r.state === 'running' ? '进行中' : r.state === 'interrupted' ? '未知' : duration(r.duration_ms)}</b></div>
    <div><span>输入 / 输出 Token</span><b>{number(input)} <em>/</em> {number(output)}</b></div>
    <div><span>缓存命中</span><b>{number(r.cache_read_tokens)} <em>Token</em></b></div>
    <div title="根据厂商输出用量与首段至末段有效内容间隔估算"><span>估算输出速度</span><b>{number(r.output_tps, 1)} <em>Token/s</em></b></div>
  </div>;
}
export function RequestTiming({ record: r }: { record: RequestRecord }) {
  const modern = !!r.metrics_version, offset = modern ? r.forward_offset_ms || 0 : 0;
  const input = inputTotal(r), output = outputTotal(r);
  const autoCache = r.input_total_basis === 'minimax_auto_cache';
  const usageState = !modern ? '旧记录 · 原始上报值' : r.usage_status === 'complete' ? '输入与最终输出已报告' : r.usage_status === 'partial' ? input != null && output != null ? '输入与输出已报告 · 最终用量未确认' : '用量不完整 · 已保留收到的部分' : '厂商未报告用量';
  const ratio = input != null && input > 0 && r.cache_read_tokens != null && r.cache_read_tokens <= input ? 100 * r.cache_read_tokens / input : null;
  const milestones = [
    ...(modern ? [{ time: 0, name: '网关收到请求', text: dateTime(r.started) }] : []),
    ...(r.forwarded || !modern ? [{ time: offset, name: '开始向上游转发', text: 'TTFT 与 TTFC 从这里开始计时' }] : []),
    ...(r.stream !== false ? [
      { time: r.first_token_ms == null ? null : offset + r.first_token_ms, name: '首个有效内容 · TTFT', text: firstTiming(r) },
      { time: r.first_text_ms == null ? null : offset + r.first_text_ms, name: '正文首字 · TTFC', text: firstTiming(r, true) },
      ...(r.last_token_ms != null ? [{ time: offset + r.last_token_ms, name: '最后一段有效内容', text: '输出阶段结束' }] : []),
    ] : []),
    { time: r.state === 'running' || r.state === 'interrupted' ? null : r.duration_ms, name: r.state === 'running' ? '请求进行中' : '本次请求结束', text: recordStatus(r) },
  ];
  return <div className="request-metrics-detail">
    <section className="detail-timing">
    <div className="timing-title"><h3>请求时间线</h3><span>{modern ? '相对网关收到请求' : '旧记录 · 相对开始转发'}</span></div>
    <div className="timeline">{milestones.map((m, i) => <div key={i} className={m.time == null ? 'milestone-unknown' : ''}><span className="dot"/><b>{duration(m.time)}</b><div><strong>{m.name}</strong><small>{m.text}</small></div></div>)}</div>
    {r.stream === false && <p className="metric-explanation">非流式响应一次性返回，无法测量 TTFT、TTFC 和输出阶段速度。</p>}
    {!modern && <p className="metric-explanation">旧记录按原口径展示；非流式首字可能是完整响应到达时间，缓存、准确输入总量和输出速度未采集。</p>}
    </section>
    <section className="detail-usage"><h3>Token 用量</h3><div className="usage-state">{usageState}</div>
      <dl className="usage-breakdown"><div><dt>输入总量</dt><dd>{number(input)}</dd></div><div><dt>普通输入</dt><dd>{number(r.input_uncached_tokens)}</dd></div><div><dt>缓存读取（命中）</dt><dd>{number(r.cache_read_tokens)}</dd></div><div><dt>缓存写入</dt><dd>{autoCache && r.cache_write_tokens == null ? <small>未单列（自动缓存）</small> : number(r.cache_write_tokens)}</dd></div><div><dt>输出总量</dt><dd>{number(output)}</dd></div><div><dt>输入＋输出合计</dt><dd>{number(input != null && output != null ? input + output : null)}</dd></div></dl>
      <div className="cache-ratio"><span>缓存命中占输入总量</span><b>{percent(ratio)}</b><div><i style={{ width: `${ratio || 0}%` }}/></div></div>
      <p className="metric-explanation">{autoCache ? 'MiniMax M3 自动缓存：输入总量＝普通输入＋缓存读取。缓存写入未单列时不影响总量；上报 0 不代表后台没有建立缓存。' : r.protocol === 'messages' ? '输入总量＝普通输入＋缓存读取＋缓存写入。' : '缓存读取是输入总量的一部分，不重复相加。'} 未报告的数量不当作零。输出采用厂商口径，可能包含思考及工具调用。</p>
    </section>
    <section className="detail-speed"><h3>输出阶段</h3><dl className="usage-breakdown"><div><dt>估算速度</dt><dd>{number(r.output_tps, 1)} <small>Token/s</small></dd></div><div><dt>估算 TPOT</dt><dd>{number(r.tpot_ms, 2)} <small>ms/Token</small></dd></div></dl><p className="metric-explanation">按首段到末段有效内容的时间与厂商输出用量估算。仅流式完整结束、用量完整且样本足够时计算；分片可能包含多个 Token，因此不是模型内部逐 Token 测量。</p></section>
    <section className="detail-outcome"><h3>请求结果</h3><dl className="usage-breakdown"><div><dt>最终结果</dt><dd>{recordStatus(r)}</dd></div><div><dt>客户端 HTTP / 上游 HTTP</dt><dd>{r.status || '—'} / {r.upstream_status || '—'}</dd></div></dl>{r.error_type && <p className="metric-explanation">{errorName(r.error_type)}。流式请求可能在 HTTP 200 后发生错误，最终结果以传输是否完整结束为准。</p>}</section>
  </div>;
}
