import { describe, expect, it } from 'vitest';
import { couponStatus, formatDuration, localTime } from './format';
import { birthDateBounds, isValidEcuadorianId, passengerIssues, type PassengerIdentity } from './passenger-validation';
import { fromQuery, toQuery } from './search-params';

/**
 * PU-4 (Informacion_General/Pruebas.md §5.1.4): utilidades de la web — validación de pasajeros ANTES de pagar (las mismas
 * reglas que la API), la búsqueda en la URL y formatos.
 */

const pasajero = (over: Partial<PassengerIdentity> = {}): PassengerIdentity => ({
  passengerType: 'ADULT',
  documentType: 'NATIONAL_ID',
  documentNumber: '1710034065',
  nationality: 'EC',
  documentExpiryDate: '2030-01-01',
  birthDate: '1990-05-01',
  ...over,
});
const viaje = { firstDeparture: '2026-12-10', lastDeparture: '2026-12-20' };

describe('validación de pasajeros (misma regla que MS.G.Bookings)', () => {
  it('pasajeros válidos no tienen avisos', () => expect(passengerIssues([pasajero()], viaje)).toEqual({}));
  it('la cédula ecuatoriana se valida igual que en el backend', () => {
    expect(isValidEcuadorianId('1710034065')).toBe(true);
    expect(passengerIssues([pasajero({ documentNumber: '1710034066' })], viaje)[0]?.documentNumber).toBe('La cédula ecuatoriana no es válida.');
  });
  it('un documento repetido dice con qué pasajero', () =>
    expect(passengerIssues([pasajero(), pasajero({ documentNumber: '171-003-4065' })], viaje)[1]?.documentNumber).toBe('Este documento ya lo tiene el pasajero 1.'));
  it('un documento que vence antes del último vuelo', () => expect(passengerIssues([pasajero({ documentExpiryDate: '2026-12-15' })], viaje)[0]?.documentExpiryDate).toBeDefined());
  it('una edad que no corresponde al tipo dice cuántos años tendrá', () =>
    expect(passengerIssues([pasajero({ birthDate: '2013-01-01' })], viaje)[0]?.birthDate).toBe('Tendrá 13 años el día del vuelo; este pasajero debe tener 15 años o más.'));
  it('solo revisa lo que ya se llenó', () => expect(passengerIssues([pasajero({ documentNumber: '', birthDate: '', documentExpiryDate: '' })], viaje)).toEqual({}));
  it('límites del calendario de nacimiento: un infante debe seguir siéndolo el día de la vuelta', () => {
    expect(birthDateBounds('ADULT', viaje.firstDeparture, viaje.lastDeparture)).toEqual({ max: '2011-12-10' });
    expect(birthDateBounds('INFANT', viaje.firstDeparture, viaje.lastDeparture)).toEqual({ min: '2024-12-21', max: '2026-12-10' });
  });
});

describe('búsqueda en la URL (se puede recargar y compartir)', () => {
  const busqueda = { itineraries: [{ origin: 'UIO', destination: 'GYE', departureDate: '2026-12-10' }, { origin: 'GYE', destination: 'UIO', departureDate: '2026-12-15' }], passengers: { adults: 2, youths: 0, children: 1, infants: 0 } };
  it('ida y vuelta: toQuery → fromQuery devuelve lo mismo', () =>
    expect(fromQuery(new URLSearchParams(toQuery(busqueda, 'ROUND_TRIP')))).toEqual({ request: busqueda, tripType: 'ROUND_TRIP' }));
  it('tramos inválidos se descartan; sin tramos no hay búsqueda', () => {
    expect(fromQuery(new URLSearchParams('tramos=uio-gye-2026-12-10'))).toBeUndefined();
    expect(fromQuery(new URLSearchParams('tramos=UIO-GYE-2026-12-10,<script>'))!.request.itineraries).toHaveLength(1);
  });
  it('cantidades fuera de rango vuelven al valor por defecto; tipo desconocido = solo ida', () => {
    const resultado = fromQuery(new URLSearchParams('tramos=UIO-GYE-2026-12-10&adultos=0&ninos=99&tipo=OTRO'))!;
    expect(resultado.request.passengers).toEqual({ adults: 1, youths: 0, children: 0, infants: 0 });
    expect(resultado.tripType).toBe('ONE_WAY');
  });
});

describe('formatos', () => {
  it('la hora local es la del aeropuerto, tal como viene (no la del navegador)', () => expect(localTime('2026-12-10T08:30:00-05:00')).toBe('08:30'));
  it('duraciones', () => {
    expect(formatDuration(50)).toBe('50 min');
    expect(formatDuration(685)).toBe('11 h 25 min');
    expect(formatDuration(0)).toBe('0 min');
    expect(formatDuration(null)).toBe('—');
  });
  it('el tramo de un boleto anulado o reembolsado se muestra así, aunque el cupón diga emitido', () => {
    expect(couponStatus('VOIDED', 'ISSUED')).toBe('VOIDED');
    expect(couponStatus('ISSUED', 'ISSUED')).toBe('ISSUED');
  });
});
