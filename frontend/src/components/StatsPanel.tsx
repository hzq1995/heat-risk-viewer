import type { ThresholdStats } from "../types";

type StatsPanelProps = {
  title: string;
  subtitle: string;
  stats: ThresholdStats;
};

const formatters = {
  mean: new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }),
  integer: new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }),
};

export function StatsPanel({ title, subtitle, stats }: StatsPanelProps) {
  return (
    <section className="panel-block">
      <div className="panel-heading">
        <span>{title}</span>
        <small>{subtitle}</small>
      </div>
      <div className="stats-grid">
        <article className="stat-card">
          <span className="stat-label">Mean</span>
          <strong>{formatters.mean.format(stats.mean)}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">P90</span>
          <strong>{formatters.integer.format(stats.p90)}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">Min</span>
          <strong>{formatters.integer.format(stats.min)}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">Max</span>
          <strong>{formatters.integer.format(stats.max)}</strong>
        </article>
      </div>
    </section>
  );
}
