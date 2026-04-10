import type { HazardPixelDistribution } from "../types";

type DistributionChartProps = {
  distribution: HazardPixelDistribution;
  threshold: number;
  labels: string[];
};

export function DistributionChart({ distribution, threshold, labels }: DistributionChartProps) {
  const width = 580;
  const height = 220;
  const margin = { top: 16, right: 18, bottom: 56, left: 42 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const maxValue = Math.max(...distribution.bins, 1);
  const barWidth = innerWidth / distribution.bins.length;
  const thresholdX = margin.left + threshold * barWidth;

  return (
    <section className="panel-block">
      <div className="panel-heading">
        <span>Pixel distribution</span>
        <small>
          row {distribution.row}, col {distribution.col}
        </small>
      </div>
      <div className="pixel-summary">
        <div>
          <span>Coordinates</span>
          <strong>
            {distribution.lng.toFixed(5)}, {distribution.lat.toFixed(5)}
          </strong>
        </div>
        <div>
          <span>Current hazard</span>
          <strong>{distribution.hazardDays} days</strong>
        </div>
      </div>
      <svg className="distribution-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Pixel temperature distribution bar chart">
        <rect x="0" y="0" width={width} height={height} rx="18" fill="rgba(6, 30, 79, 0.03)" />
        <line x1={margin.left} y1={margin.top} x2={margin.left} y2={margin.top + innerHeight} className="chart-axis" />
        <line
          x1={margin.left}
          y1={margin.top + innerHeight}
          x2={margin.left + innerWidth}
          y2={margin.top + innerHeight}
          className="chart-axis"
        />
        <line x1={thresholdX} y1={margin.top} x2={thresholdX} y2={margin.top + innerHeight} className="chart-threshold" />
        {distribution.bins.map((value, index) => {
          const barHeight = (value / maxValue) * innerHeight;
          const x = margin.left + index * barWidth + 0.7;
          const y = margin.top + innerHeight - barHeight;
          const active = index >= threshold;
          return (
            <rect
              key={labels[index]}
              x={x}
              y={y}
              width={Math.max(barWidth - 1.4, 1)}
              height={barHeight}
              rx="2"
              className={active ? "chart-bar chart-bar-active" : "chart-bar"}
            />
          );
        })}
        {[0, maxValue].map((tickValue) => {
          const y = margin.top + innerHeight - (tickValue / maxValue) * innerHeight;
          return (
            <g key={tickValue}>
              <line x1={margin.left} y1={y} x2={margin.left + innerWidth} y2={y} className="chart-grid" />
              <text x={margin.left - 8} y={y + 4} textAnchor="end" className="chart-label">
                {tickValue}
              </text>
            </g>
          );
        })}
        {labels.filter((_, index) => index % 5 === 0).map((label, idx) => {
          const index = idx * 5;
          const x = margin.left + index * barWidth + barWidth / 2;
          return (
            <text key={label} x={x} y={height - 22} textAnchor="middle" className="chart-label chart-label-small">
              {label.replace("°C", "")}
            </text>
          );
        })}
      </svg>
      <p className="chart-caption">Highlighted bars mark temperature bins at or above the active threshold.</p>
    </section>
  );
}
