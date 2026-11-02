import { API_PREFIX } from './app.js';

/**
 * Enlaces HATEOAS (`Links` del contrato v2): las acciones disponibles según el estado del recurso, con la ruta pública
 * `/api/v2/vuelos/...` (la que publica el gateway).
 */
export type Link = { href: string; method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' };
export type Links = Record<string, Link>;

export const publicPath = (path: string) => `${API_PREFIX}${path}`;
const link = (path: string, method: Link['method'] = 'GET'): Link => ({ href: publicPath(path), method });

const ACTIVE = ['CONFIRMED', 'TICKET_ISSUING', 'CHANGE_PENDING'];

/** Reserva: siempre `self` y `tickets`; las acciones de postventa solo si sigue vigente. */
export function bookingLinks(booking: { bookingId: string; status?: string }): Links {
  const base = `/vuelos/bookings/${booking.bookingId}`;
  const links: Links = { self: link(base), tickets: link(`${base}/tickets`) };
  if (booking.status && ACTIVE.includes(booking.status)) {
    Object.assign(links, {
      'issue-tickets': link(`${base}/tickets`, 'POST'),
      seats: link(`${base}/seats`, 'PUT'),
      'check-in': link(`${base}/check-in`, 'POST'),
      'boarding-passes': link(`${base}/boarding-passes`),
      'baggage-options': link(`${base}/baggage-options`),
      'date-change-search': link(`${base}/date-change/search`, 'POST'),
      'cancellation-quote': link(`${base}/cancellation-quote`),
      cancel: link(`${base}/cancel`, 'POST'),
    });
  }
  return links;
}

/** Hold: `self`; si sigue `HELD`, liberar y reservar con él. */
export function holdLinks(hold: { holdId: string; status?: string }): Links {
  const links: Links = { self: link(`/vuelos/offers/hold/${hold.holdId}`) };
  if (hold.status === 'HELD') Object.assign(links, { release: link(`/vuelos/offers/hold/${hold.holdId}`, 'DELETE'), book: link('/vuelos/bookings', 'POST') });
  return links;
}
