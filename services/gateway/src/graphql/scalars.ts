import { GraphQLError, GraphQLScalarType, Kind, type ValueNode } from 'graphql';

/**
 * Escalares de `gateway.graphql`. Validan lo que llega (argumentos y variables): un valor inválido es un error del documento
 * (`400`, `VALIDATION_FAILED`) antes de llamar a ningún MS. Lo que sale ya lo validó el MS contra su contrato, así que al
 * serializar solo se exige el tipo de JavaScript correcto.
 */
/** graphql-js lo reporta como error del documento; `formatError` lo publica como `VALIDATION_FAILED` (400). */
const invalid = (scalar: string, reason: string) => new GraphQLError(`Valor inválido para ${scalar}: ${reason}.`);

function stringScalar(name: string, description: string, check: (value: string) => string | undefined): GraphQLScalarType<string, string> {
  const parse = (value: unknown): string => {
    if (typeof value !== 'string') throw invalid(name, 'debe ser un texto');
    const problem = check(value);
    if (problem) throw invalid(name, problem);
    return value;
  };
  return new GraphQLScalarType<string, string>({
    name,
    description,
    serialize: (value) => {
      if (typeof value === 'string') return value;
      if (typeof value === 'number') return String(value);
      throw new GraphQLError(`${name}: el servicio devolvió un valor que no es texto.`);
    },
    parseValue: parse,
    parseLiteral: (ast: ValueNode) => {
      if (ast.kind !== Kind.STRING) throw invalid(name, 'debe ser un texto');
      return parse(ast.value);
    },
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const validDate = (value: string) => {
  const match = DATE.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
};

export const scalarResolvers = {
  UUID: stringScalar('UUID', 'UUID (RFC 4122).', (v) => (UUID.test(v) ? undefined : 'no es un UUID')),
  Date: stringScalar('Date', 'Fecha ISO-8601 (YYYY-MM-DD).', (v) => (validDate(v) ? undefined : 'se espera AAAA-MM-DD')),
  DateTime: stringScalar('DateTime', 'Fecha y hora RFC 3339.', (v) => (DATE_TIME.test(v) && !Number.isNaN(Date.parse(v)) ? undefined : 'se espera fecha y hora RFC 3339')),
  IataCode: stringScalar('IataCode', 'Código IATA de aeropuerto.', (v) => (/^[A-Z]{3}$/.test(v) ? undefined : 'tres letras mayúsculas')),
  CurrencyCode: stringScalar('CurrencyCode', 'Moneda ISO-4217.', (v) => (/^[A-Z]{3}$/.test(v) ? undefined : 'tres letras mayúsculas')),
  Decimal: stringScalar('Decimal', 'Monto decimal como texto.', (v) => (/^-?\d{1,12}(\.\d{1,4})?$/.test(v) ? undefined : 'número decimal como texto, p. ej. "125.40"')),
  URL: stringScalar('URL', 'URL absoluta.', (v) => {
    try {
      return ['http:', 'https:'].includes(new URL(v).protocol) && v.length <= 500 ? undefined : 'debe ser http(s), hasta 500 caracteres';
    } catch {
      return 'no es una URL absoluta';
    }
  }),
  JSON: new GraphQLScalarType({
    name: 'JSON',
    description: 'Objeto JSON libre (solo salida: los datos de un evento en el historial).',
    serialize: (value) => value,
    parseValue: () => {
      throw invalid('JSON', 'solo se usa en respuestas');
    },
    parseLiteral: () => {
      throw invalid('JSON', 'solo se usa en respuestas');
    },
  }),
};
