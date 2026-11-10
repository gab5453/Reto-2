import type { JourneyLayer } from '../../api/admin';

/**
 * Grafo por capas en SVG propio (PLAN_Telemetria_Asientos T-4, D-T2): Cliente → Gateway → MS de respuesta → ESB → MS de gestión →
 * externos, de izquierda a derecha. Lo usan la vista «Recorrido» (con el punto que viaja de nodo en nodo) y el mapa en vivo.
 */
export const LAYERS: { id: JourneyLayer; label: string }[] = [
  { id: 'CLIENT', label: 'Cliente' },
  { id: 'GATEWAY', label: 'Gateway' },
  { id: 'RESPONSE', label: 'MS de respuesta' },
  { id: 'ESB', label: 'ESB' },
  { id: 'MANAGEMENT', label: 'MS de gestión' },
  { id: 'EXTERNAL', label: 'Externos' },
];

const RESPONSE = new Set(['ms-vuelos', 'ms-reservas', 'ms-postventa', 'ms-clientes', 'ms-admin']);

/** La misma clasificación que el ESB (para el mapa en vivo, que solo trae nombres). */
export function layerOf(service: string): JourneyLayer {
  if (service === 'cliente') return 'CLIENT';
  if (service === 'gateway') return 'GATEWAY';
  if (RESPONSE.has(service)) return 'RESPONSE';
  if (service === 'esb') return 'ESB';
  if (service.startsWith('ms-g-')) return 'MANAGEMENT';
  return 'EXTERNAL';
}

/** «ms-g-bookings» → «MS.G.Bookings»; «ms-reservas» → «MS.Reservas». */
export function nodeLabel(id: string): string {
  if (id === 'cliente') return 'Cliente (web/Booking)';
  if (id === 'gateway') return 'Gateway';
  if (id === 'esb') return 'ESB';
  if (id === 'payment-api') return 'Payment API';
  const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
  if (id.startsWith('ms-g-')) return `MS.G.${id.slice(5).split('-').map(capital).join('')}`;
  if (id.startsWith('ms-')) return `MS.${id.slice(3).split('-').map(capital).join('')}`;
  return id;
}

export interface GraphNode {
  id: string;
  layer: JourneyLayer;
}

export interface GraphEdge {
  key: string;
  from: string;
  to: string;
  /** Texto pequeño sobre la arista (p. ej. «12/min»). */
  label?: string;
  tone?: 'normal' | 'error' | 'active' | 'visited' | 'idle';
  width?: number;
  /** Texto del tooltip. */
  title?: string;
}

const W = 1000;
export const NODE_W = 132;
export const NODE_H = 36;
const ROW = 56;
const TOP = 46;

export interface Layout {
  width: number;
  height: number;
  position: Map<string, { x: number; y: number }>;
  columns: { label: string; x: number }[];
}

export function layout(nodes: GraphNode[]): Layout {
  const columns = LAYERS.filter((layer) => nodes.some((node) => node.layer === layer.id));
  const maxRows = Math.max(1, ...columns.map((column) => nodes.filter((node) => node.layer === column.id).length));
  const height = TOP + maxRows * ROW + 10;
  const step = columns.length > 1 ? (W - NODE_W - 20) / (columns.length - 1) : 0;
  const position = new Map<string, { x: number; y: number }>();
  const placed = columns.map((column, index) => {
    const x = columns.length > 1 ? 10 + NODE_W / 2 + index * step : W / 2;
    const members = nodes.filter((node) => node.layer === column.id).sort((a, b) => a.id.localeCompare(b.id));
    const offset = TOP + ((maxRows - members.length) * ROW) / 2 + ROW / 2;
    members.forEach((node, row) => position.set(node.id, { x, y: offset + row * ROW }));
    return { label: column.label, x };
  });
  return { width: W, height, position, columns: placed };
}

/** Curva de la arista: del borde derecho del origen al borde izquierdo del destino (o un arco si va hacia atrás). */
export function edgeCurve(from: { x: number; y: number }, to: { x: number; y: number }) {
  const forward = to.x > from.x;
  const p0 = { x: from.x + (forward ? NODE_W / 2 : 0), y: from.y + (forward ? 0 : NODE_H / 2) };
  const p3 = { x: to.x - (forward ? NODE_W / 2 : 0), y: to.y + (forward ? 0 : NODE_H / 2) };
  const dx = forward ? Math.max(40, (p3.x - p0.x) / 2) : 0;
  const dy = forward ? 0 : 60;
  const p1 = { x: p0.x + dx, y: p0.y + dy };
  const p2 = { x: p3.x - dx, y: p3.y + dy };
  return { p0, p1, p2, p3, d: `M ${p0.x} ${p0.y} C ${p1.x} ${p1.y}, ${p2.x} ${p2.y}, ${p3.x} ${p3.y}` };
}

export function pointOn(curve: ReturnType<typeof edgeCurve>, t: number) {
  const u = 1 - t;
  const { p0, p1, p2, p3 } = curve;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}
