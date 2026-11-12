import { createCloudEvent, type ProblemDetailsException } from '@ecoairlines/shared';
import { assertAllowedUrl, canReadFeed, canReceive, nextRetryAt, RETRY_DELAYS_MS, SecretBox, targetOf, toEventRecord } from './rules.js';

/**
 * PU-1 (Informacion_General/Pruebas.md §5.1.1): reglas de MS.G.Webhooks — quién recibe qué (D40), reintentos, protección
 * contra SSRF y cifrado del secreto. Las URL usan IP literales para no depender del DNS.
 */

const rechazo = async (url: string, production = true): Promise<string | undefined> => {
  try {
    await assertAllowedUrl(url, production);
    return undefined;
  } catch (error) {
    return (error as ProblemDetailsException).problem.invalidParams?.[0]?.reason;
  }
};

const PARTNER = 'partner:BOOKING_PROTOTIPO';
const evento = (name: string, ownerId: string | null, isPublic = true) => ({ name, public: isPublic, ownerId });

describe('canReceive: quién recibe cada evento (D40)', () => {
  it('un evento interno no sale nunca, ni al administrador', () => expect(canReceive('admin-sub', evento('schedule.published', null, false))).toBe(false));
  it('el administrador recibe todo lo público', () => expect(canReceive('admin-sub', evento('booking.confirmed', 'otro-dueño'))).toBe(true));
  it('el partner recibe las reservas de su canal', () => expect(canReceive(PARTNER, evento('booking.confirmed', `${PARTNER}:usuario-1`))).toBe(true));
  it('el partner no recibe las reservas de la web', () => expect(canReceive(PARTNER, evento('booking.confirmed', 'cliente-web'))).toBe(false));
  it('el partner no recibe las de otro partner con un id que empieza igual', () => expect(canReceive(PARTNER, evento('hold.created', `${PARTNER}_2:u`))).toBe(false));
  it('el partner recibe todos los eventos de vuelos', () => expect(canReceive(PARTNER, evento('flight.status_changed', null))).toBe(true));
  it('un evento de reserva sin dueño no le llega al partner', () => expect(canReceive(PARTNER, evento('booking.confirmed', null))).toBe(false));
});

describe('canReadFeed: el feed GET /vuelos/eventos', () => {
  it('un CLIENTE solo ve los eventos de sus reservas', () => {
    expect(canReadFeed('cliente-1', undefined, evento('booking.confirmed', 'cliente-1'))).toBe(true);
    expect(canReadFeed('cliente-1', undefined, evento('booking.confirmed', 'cliente-2'))).toBe(false);
  });
  it('un CLIENTE no ve los eventos de vuelos de otros', () => expect(canReadFeed('cliente-1', undefined, evento('flight.status_changed', null))).toBe(false));
  it('un ADMIN (X-Actor-Id = su sub) ve todo lo público', () => expect(canReadFeed('admin-1', 'admin-1', evento('booking.confirmed', 'cliente-2'))).toBe(true));
  it('el partner lee como recibe sus webhooks', () => expect(canReadFeed(PARTNER, undefined, evento('booking.confirmed', `${PARTNER}:u`))).toBe(true));
  it('un evento interno de mi propia reserva tampoco sale', () => expect(canReadFeed('cliente-1', undefined, evento('booking.internal', 'cliente-1', false))).toBe(false));
});

describe('toEventRecord', () => {
  it('guarda nombre, asunto, correlation ID, dueño y si es público', () => {
    const cloudEvent = createCloudEvent({ name: 'booking.confirmed', visibility: 'public', subject: 'b-1', data: {}, correlationId: 'corr-1' });
    expect(toEventRecord(cloudEvent, 'cliente-1')).toMatchObject({ id: cloudEvent.id, name: 'booking.confirmed', subject: 'b-1', correlationId: 'corr-1', ownerId: 'cliente-1', public: true });
  });
  it('un evento interno queda marcado como no público', () => {
    const cloudEvent = createCloudEvent({ name: 'schedule.published', visibility: 'internal', subject: 'x', data: {}, correlationId: 'c' });
    expect(toEventRecord(cloudEvent, undefined)).toMatchObject({ public: false, ownerId: null });
  });
});

describe('nextRetryAt: reintentos 1 min, 5 min, 30 min, 2 h y 6 h', () => {
  const ahora = Date.parse('2026-11-11T12:00:00Z');
  it('tras el primer fallo, en 1 minuto', () => expect(nextRetryAt(1, ahora)).toBe('2026-11-11T12:01:00.000Z'));
  it('tras el quinto, en 6 horas', () => expect(nextRetryAt(5, ahora)).toBe('2026-11-11T18:00:00.000Z'));
  it(`tras ${RETRY_DELAYS_MS.length + 1} fallos se agota (null)`, () => expect(nextRetryAt(RETRY_DELAYS_MS.length + 1, ahora)).toBeNull());
  it('las esperas crecen', () => expect([...RETRY_DELAYS_MS].sort((a, b) => a - b)).toEqual(RETRY_DELAYS_MS));
});

describe('assertAllowedUrl: protección contra SSRF', () => {
  it('en producción, https a una IP pública pasa', async () => expect(await rechazo('https://8.8.8.8/hooks')).toBeUndefined());
  it('en producción, http no', async () => expect(await rechazo('http://8.8.8.8/hooks')).toBe('debe ser https'));
  it.each(['https://10.0.0.5/x', 'https://127.0.0.1/x', 'https://192.168.1.10/x', 'https://172.16.0.1/x', 'https://169.254.169.254/latest', 'https://100.64.0.1/x', 'https://[::1]/x', 'https://[fd00::1]/x'])(
    '%s apunta a una red privada',
    async (url) => expect(await rechazo(url)).toBe('apunta a una red privada'),
  );
  it('172.15.x y 172.32.x ya son públicas', async () => {
    expect(await rechazo('https://172.15.0.1/x')).toBeUndefined();
    expect(await rechazo('https://172.32.0.1/x')).toBeUndefined();
  });
  it.each(['https://localhost/x', 'https://servicio.local/x', 'https://db.internal/x'])('%s es un host interno', async (url) => expect(await rechazo(url)).toBe('host interno'));
  it('no se aceptan credenciales en la URL', async () => expect(await rechazo('https://usuario:clave@8.8.8.8/x')).toBe('sin credenciales en la URL'));
  it('un texto que no es URL', async () => expect(await rechazo('no es una url')).toBe('no es una URL'));
  it('en desarrollo, http a la red interna pasa (booking-simulado)', async () => expect(await rechazo('http://booking-simulado:3000/hooks', false)).toBeUndefined());
  it('en desarrollo, otro protocolo no', async () => expect(await rechazo('ftp://booking-simulado/hooks', false)).toBe('http o https'));
});

describe('SecretBox: el secreto se guarda cifrado (AES-256-GCM)', () => {
  const caja = new SecretBox('clave-de-prueba');
  it('lo que se cifra se puede descifrar', () => expect(caja.open(caja.seal('whsec_123'))).toBe('whsec_123'));
  it('cifrar dos veces lo mismo da textos distintos (IV aleatorio) y no contiene el secreto', () => {
    const [a, b] = [caja.seal('whsec_123'), caja.seal('whsec_123')];
    expect(a).not.toBe(b);
    expect(a).not.toContain('whsec_123');
  });
  it('con otra clave no se descifra', () => expect(() => new SecretBox('otra-clave').open(caja.seal('whsec_123'))).toThrow());
  it('si alguien altera el texto cifrado, falla (integridad)', () => {
    const [iv, tag, data] = caja.seal('whsec_123').split('.');
    const alterado = Buffer.from(data, 'base64url');
    alterado[0] = alterado[0] ^ 0xff;
    expect(() => caja.open([iv, tag, alterado.toString('base64url')].join('.'))).toThrow();
  });
});

describe('targetOf: el historial guarda solo el host', () => {
  it('sin ruta ni token', () => expect(targetOf('https://hooks.example.com:8443/recibir?token=secreto')).toBe('hooks.example.com:8443'));
  it('una URL inválida da texto vacío', () => expect(targetOf('::::')).toBe(''));
});
