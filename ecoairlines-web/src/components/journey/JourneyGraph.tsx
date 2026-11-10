import { edgeCurve, layout, NODE_H, NODE_W, nodeLabel, pointOn, type GraphEdge, type GraphNode } from './layout';

/** Grafo por capas en SVG (ver `layout.ts`): nodos, aristas y el punto viajero de la vista «Recorrido». */
export function JourneyGraph({
  nodes,
  edges,
  activeNodes = [],
  dot,
  label,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  activeNodes?: string[];
  /** El punto viajero: sobre la arista de `from` a `to`, en `progress` (0 a 1). */
  dot?: { from: string; to: string; progress: number; error: boolean } | undefined;
  label: string;
}) {
  const shape = layout(nodes);
  const at = (id: string) => shape.position.get(id);
  const dotCurve = dot && at(dot.from) && at(dot.to) ? edgeCurve(at(dot.from)!, at(dot.to)!) : undefined;
  const dotPoint = dotCurve ? pointOn(dotCurve, dot!.progress) : undefined;
  return (
    <svg className="journey-graph" viewBox={`0 0 ${shape.width} ${shape.height}`} role="img" aria-label={label} preserveAspectRatio="xMidYMin meet">
      <defs>
        <marker id="journey-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" className="journey-arrow" />
        </marker>
      </defs>
      {shape.columns.map((column) => (
        <text key={column.label} x={column.x} y={18} textAnchor="middle" className="journey-column">{column.label}</text>
      ))}
      {edges.map((edge) => {
        const from = at(edge.from);
        const to = at(edge.to);
        if (!from || !to) return null;
        const curve = edgeCurve(from, to);
        const middle = pointOn(curve, 0.5);
        return (
          <g key={edge.key} className={`journey-edge is-${edge.tone ?? 'normal'}`}>
            <path d={curve.d} strokeWidth={edge.width ?? 1.5} markerEnd="url(#journey-arrow)">
              {edge.title ? <title>{edge.title}</title> : null}
            </path>
            {edge.label ? <text x={middle.x} y={middle.y - 5} textAnchor="middle" className="journey-edge-label">{edge.label}</text> : null}
          </g>
        );
      })}
      {nodes.map((node) => {
        const p = at(node.id);
        if (!p) return null;
        return (
          <g key={node.id} className={`journey-node layer-${node.layer.toLowerCase()} ${activeNodes.includes(node.id) ? 'is-active' : ''}`}>
            <rect x={p.x - NODE_W / 2} y={p.y - NODE_H / 2} width={NODE_W} height={NODE_H} rx={8} />
            <text x={p.x} y={p.y + 4} textAnchor="middle">{nodeLabel(node.id)}</text>
          </g>
        );
      })}
      {dotPoint ? <circle cx={dotPoint.x} cy={dotPoint.y} r={7} className={`journey-dot ${dot!.error ? 'is-error' : ''}`} /> : null}
    </svg>
  );
}
