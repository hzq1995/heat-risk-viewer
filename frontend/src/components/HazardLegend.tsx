type LegendStop = {
  value: number;
  color: string;
};

type HazardLegendProps = {
  title: string;
  unitLabel: string;
  domain: [number, number];
  stops: LegendStop[];
};

function formatLegendValue(value: number): string {
  if (value >= 1000) {
    return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
  }
  if (value >= 10) {
    return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
  }
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function HazardLegend({ title, unitLabel, domain, stops }: HazardLegendProps) {
  const gradient = stops
    .map((stop) => {
      const percentage = ((stop.value - domain[0]) / (domain[1] - domain[0])) * 100;
      return `${stop.color} ${percentage}%`;
    })
    .join(", ");

  return (
    <section className="panel-block">
      <div className="panel-heading">
        <span>{title}</span>
        <small>
          {formatLegendValue(domain[0])} - {formatLegendValue(domain[1])} {unitLabel}
        </small>
      </div>
      <div className="legend-swatch" style={{ background: `linear-gradient(90deg, ${gradient})` }} />
      <div className="legend-scale">
        <span>{formatLegendValue(domain[0])}</span>
        <span>{formatLegendValue((domain[0] + domain[1]) / 2)}</span>
        <span>{formatLegendValue(domain[1])}</span>
      </div>
    </section>
  );
}
