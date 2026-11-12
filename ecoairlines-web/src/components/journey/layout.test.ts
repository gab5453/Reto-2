import { describe, expect, it } from 'vitest';
import { edgeCurve, layerOf, layout, NODE_W, nodeLabel, pointOn } from './layout';

/** PU-4 (Informacion_General/Pruebas.md §5.1.4): el dibujo del grafo por capas de «Recorrido» y del mapa en vivo (T-4). */

describe('capas y nombres de los nodos', () => {
  it('la misma clasificación que el ESB', () =>
    expect(['cliente', 'gateway', 'ms-reservas', 'esb', 'ms-g-offers', 'payment-api'].map(layerOf)).toEqual(['CLIENT', 'GATEWAY', 'RESPONSE', 'ESB', 'MANAGEMENT', 'EXTERNAL']));
  it('nombres legibles', () => {
    expect(nodeLabel('ms-g-flight-status')).toBe('MS.G.FlightStatus');
    expect(nodeLabel('ms-reservas')).toBe('MS.Reservas');
    expect(nodeLabel('cliente')).toBe('Cliente (web/Booking)');
    expect(nodeLabel('otro-servicio')).toBe('otro-servicio');
  });
});

describe('layout: posiciones', () => {
  const nodos = [
    { id: 'cliente', layer: 'CLIENT' as const },
    { id: 'gateway', layer: 'GATEWAY' as const },
    { id: 'esb', layer: 'ESB' as const },
    { id: 'ms-g-offers', layer: 'MANAGEMENT' as const },
    { id: 'ms-g-bookings', layer: 'MANAGEMENT' as const },
  ];

  it('solo las capas que tienen nodos, de izquierda a derecha', () => {
    const { columns, position } = layout(nodos);
    expect(columns.map((c) => c.label)).toEqual(['Cliente', 'Gateway', 'ESB', 'MS de gestión']);
    expect(position.get('cliente')!.x).toBeLessThan(position.get('gateway')!.x);
    expect(position.get('esb')!.x).toBeLessThan(position.get('ms-g-offers')!.x);
  });
  it('los nodos de una capa van en la misma columna, en orden alfabético y sin encimarse', () => {
    const { position } = layout(nodos);
    const bookings = position.get('ms-g-bookings')!;
    const offers = position.get('ms-g-offers')!;
    expect(bookings.x).toBe(offers.x);
    expect(bookings.y).toBeLessThan(offers.y);
    expect(offers.y - bookings.y).toBeGreaterThanOrEqual(36);
  });
  it('una capa con un solo nodo queda centrada respecto de la más poblada', () => {
    const { position } = layout(nodos);
    expect(position.get('esb')!.y).toBe((position.get('ms-g-bookings')!.y + position.get('ms-g-offers')!.y) / 2);
  });
  it('un solo nodo va al centro del dibujo', () => expect(layout([{ id: 'esb', layer: 'ESB' }]).position.get('esb')!.x).toBe(500));
  it('el alto crece con la capa más poblada', () => expect(layout(nodos).height).toBeGreaterThan(layout([{ id: 'esb', layer: 'ESB' }]).height));
});

describe('aristas', () => {
  it('hacia adelante: del borde derecho del origen al borde izquierdo del destino', () => {
    const curve = edgeCurve({ x: 100, y: 50 }, { x: 400, y: 50 });
    expect(curve.p0).toEqual({ x: 100 + NODE_W / 2, y: 50 });
    expect(curve.p3).toEqual({ x: 400 - NODE_W / 2, y: 50 });
    expect(curve.d.startsWith('M ')).toBe(true);
  });
  it('hacia atrás (una respuesta): un arco por debajo', () => {
    const curve = edgeCurve({ x: 400, y: 50 }, { x: 100, y: 50 });
    expect(curve.p1.y).toBeGreaterThan(curve.p0.y);
  });
  it('pointOn: el punto que viaja empieza en el origen y termina en el destino', () => {
    const curve = edgeCurve({ x: 100, y: 50 }, { x: 400, y: 120 });
    expect(pointOn(curve, 0)).toEqual(curve.p0);
    expect(pointOn(curve, 1)).toEqual(curve.p3);
    const medio = pointOn(curve, 0.5);
    expect(medio.x).toBeGreaterThan(curve.p0.x);
    expect(medio.x).toBeLessThan(curve.p3.x);
  });
});
