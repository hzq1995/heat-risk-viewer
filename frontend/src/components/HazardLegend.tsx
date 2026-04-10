import type { HazardMetadata } from "../types";

type HazardLegendProps = {
  metadata: HazardMetadata;
};

export function HazardLegend({ metadata }: HazardLegendProps) {
  const gradient = metadata.legendStops
    .map((stop) => {
      const percentage =
        ((stop.value - metadata.legendDomain[0]) / (metadata.legendDomain[1] - metadata.legendDomain[0])) * 100;
      return `${stop.color} ${percentage}%`;
    })
    .join(", ");

  return (
    <section className="panel-block">
      <div className="panel-heading">
        <span>Hazard legend</span>
        <small>
          {metadata.legendDomain[0]} - {metadata.legendDomain[1]} days
        </small>
      </div>
      <div className="legend-swatch" style={{ background: `linear-gradient(90deg, ${gradient})` }} />
      <div className="legend-scale">
        <span>{metadata.legendDomain[0]}</span>
        <span>{Math.round((metadata.legendDomain[0] + metadata.legendDomain[1]) / 2)}</span>
        <span>{metadata.legendDomain[1]}</span>
      </div>
    </section>
  );
}
