import { bcbp, boardingGroup, julianDay } from './boarding.js';

/** PU-1 (Informacion_General/Pruebas.md §5.1.1): pase de abordar — grupo de embarque, día juliano y código IATA BCBP. */

describe('boardingGroup', () => {
  it('Business y First abordan primero (A)', () => {
    expect(boardingGroup({ cabinClass: 'BUSINESS', seat: '2A', needsAssistance: false })).toBe('A');
    expect(boardingGroup({ cabinClass: 'FIRST', seat: '1A', needsAssistance: false })).toBe('A');
  });
  it('un pasajero con asistencia aborda en A aunque vaya en Economy', () => expect(boardingGroup({ cabinClass: 'ECONOMY', seat: '30F', needsAssistance: true })).toBe('A'));
  it('Economy de atrás hacia adelante: fila 20 en adelante B, antes C', () => {
    expect(boardingGroup({ cabinClass: 'ECONOMY', seat: '20A', needsAssistance: false })).toBe('B');
    expect(boardingGroup({ cabinClass: 'ECONOMY', seat: '19F', needsAssistance: false })).toBe('C');
    expect(boardingGroup({ cabinClass: 'ECONOMY', seat: '4C', needsAssistance: false })).toBe('C');
  });
  it('sin asiento (infante en brazos) aborda en B', () => expect(boardingGroup({ cabinClass: 'ECONOMY', seat: null, needsAssistance: false })).toBe('B'));
});

describe('julianDay', () => {
  it('1 de enero = 001', () => expect(julianDay('2026-01-01')).toBe('001'));
  it('10 de diciembre de 2026 = 344', () => expect(julianDay('2026-12-10')).toBe('344'));
  it('31 de diciembre: 365 en año normal y 366 en bisiesto', () => {
    expect(julianDay('2026-12-31')).toBe('365');
    expect(julianDay('2028-12-31')).toBe('366');
  });
  it('el 1 de marzo cambia con el año bisiesto', () => {
    expect(julianDay('2027-03-01')).toBe('060');
    expect(julianDay('2028-03-01')).toBe('061');
  });
});

describe('bcbp: código de barras IATA (M1, 60 caracteres)', () => {
  const pase = {
    firstName: 'María',
    lastName: 'Torres',
    pnr: 'K7P2Q',
    origin: 'UIO',
    destination: 'GYE',
    flightNumber: 'EA100',
    departureAt: '2026-10-26T08:00:00-05:00',
    cabinClass: 'ECONOMY',
    seat: '12A',
    boardingPosition: 1,
  };

  it('el ejemplo de la documentación', () => expect(bcbp(pase)).toBe('M1TORRES/MARIA        EK7P2Q  UIOGYEEA 0100 299Y012A0001 100'));
  it('siempre mide 60 caracteres', () => {
    expect(bcbp(pase)).toHaveLength(60);
    expect(bcbp({ ...pase, firstName: 'Ana Lucía Fernanda', lastName: 'De la Torre Villacís', seat: null, flightNumber: 'EA1234', boardingPosition: 123 })).toHaveLength(60);
  });
  it('quita tildes, eñes y espacios del nombre, y lo corta a 20', () => {
    const codigo = bcbp({ ...pase, firstName: 'José María', lastName: 'Muñoz Peña Villacrés' });
    expect(codigo.slice(2, 22)).toBe('MUNOZPENAVILLACRES/J');
  });
  it('Business es J, Economy es Y', () => {
    expect(bcbp({ ...pase, cabinClass: 'BUSINESS' })[47]).toBe('J');
    expect(bcbp(pase)[47]).toBe('Y');
  });
  it('un infante sin asiento lleva INF', () => expect(bcbp({ ...pase, seat: null }).slice(48, 52)).toBe('INF '));
  it('el asiento de una cifra se completa con ceros (5C → 005C)', () => expect(bcbp({ ...pase, seat: '5C' }).slice(48, 52)).toBe('005C'));
  it('la posición de embarque es la secuencia', () => expect(bcbp({ ...pase, boardingPosition: 42 }).slice(52, 57)).toBe('0042 '));
});
