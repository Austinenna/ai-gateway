import type { Metrics } from './monitoring';

type ModelMetric = Metrics['models'][number];
export type ModelSortKey = 'requests' | 'success_rate' | 'ttft' | 'ttfc' | 'input_tokens' | 'output_tokens' | 'cache_ratio' | 'speed';
export type ModelSort = { key: ModelSortKey; direction: 'ascending' | 'descending' };

export function nextModelSort(current: ModelSort, key: ModelSortKey): ModelSort {
  return { key, direction: current.key === key
    ? current.direction === 'descending' ? 'ascending' : 'descending'
    : key === 'ttft' || key === 'ttfc' ? 'ascending' : 'descending' };
}

function value(row: ModelMetric, key: ModelSortKey): number | null {
  switch (key) {
    case 'ttft': return row.ttft.p95;
    case 'ttfc': return row.ttfc.p95;
    case 'speed': return row.speed.p50;
    case 'input_tokens': return row.input_samples ? row.input_tokens : null;
    case 'output_tokens': return row.output_samples ? row.output_tokens : null;
    default: return row[key];
  }
}

export function sortModelMetrics(rows: ModelMetric[], sort: ModelSort): ModelMetric[] {
  return [...rows].sort((a, b) => {
    // Unrouted requests and missing values stay last in either direction.
    const unrouted = Number(!a.model_id) - Number(!b.model_id);
    if (unrouted) return unrouted;
    const av = value(a, sort.key), bv = value(b, sort.key);
    if (av == null && bv != null) return 1;
    if (bv == null && av != null) return -1;
    if (av != null && bv != null && av !== bv) return (av - bv) * (sort.direction === 'ascending' ? 1 : -1);
    return a.alias.localeCompare(b.alias, 'zh-CN') || a.connection_name.localeCompare(b.connection_name, 'zh-CN')
      || a.model_id.localeCompare(b.model_id) || a.connection_id.localeCompare(b.connection_id);
  });
}
