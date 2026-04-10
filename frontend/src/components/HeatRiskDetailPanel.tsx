import type { HeatRiskPixelDetail } from "../types";

type HeatRiskDetailPanelProps = {
  detail: HeatRiskPixelDetail;
  threshold: number;
};

const integerFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const decimalFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });

export function HeatRiskDetailPanel({ detail, threshold }: HeatRiskDetailPanelProps) {
  return (
    <section className="panel-block">
      <div className="panel-heading">
        <span>Heat risk breakdown</span>
        <small>
          row {detail.row}, col {detail.col}
        </small>
      </div>

      <div className="pixel-summary">
        <div>
          <span>Coordinates</span>
          <strong>
            {detail.lng.toFixed(5)}, {detail.lat.toFixed(5)}
          </strong>
        </div>
        <div>
          <span>Active threshold</span>
          <strong>{threshold}°C</strong>
        </div>
      </div>

      <div className="formula-card">
        <p>heat risk = hazard x population x (1 + vulnerability)</p>
      </div>

      <div className="stats-grid">
        <article className="stat-card">
          <span className="stat-label">Hazard</span>
          <strong>{integerFormatter.format(detail.hazard)}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">Population</span>
          <strong>{decimalFormatter.format(detail.population)}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">Vulnerability</span>
          <strong>{decimalFormatter.format(detail.vulnerability)}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">Heat risk</span>
          <strong>{decimalFormatter.format(detail.heatRisk)}</strong>
        </article>
      </div>
    </section>
  );
}
