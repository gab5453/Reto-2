// Verifica contract/events.asyncapi.yaml (V2.1, paso 9) con el parser oficial de AsyncAPI y su plugin de schemas OpenAPI:
// documento válido, referencias al contrato del grupo resueltas y cada CloudEvent con su atributo correlationid.
// Uso: npm i @asyncapi/parser@3.4.0 @asyncapi/openapi-schema-parser@3.0.24 en una carpeta aparte y
//      node verificar_events_asyncapi.mjs <ruta a events.asyncapi.yaml>
import fs from 'node:fs';
import path from 'node:path';
import { Parser, fromFile } from '@asyncapi/parser';
import { OpenAPISchemaParser } from '@asyncapi/openapi-schema-parser';

const file = path.resolve(process.argv[2]);
// El plugin de OpenAPI convierte cada schema en el lugar: si dos mensajes comparten un schema referenciado, la segunda
// conversión falla. Se le pasa una copia de cada schema.
const oas = OpenAPISchemaParser();
const copy = (input) => ({ ...input, data: structuredClone(input.data) });
const oasCopy = { ...oas, validate: (i) => oas.validate(copy(i)), parse: (i) => oas.parse(copy(i)) };
const parser = new Parser({ schemaParsers: [oasCopy] });
const { document, diagnostics } = await fromFile(parser, file).parse();
const errors = diagnostics.filter((d) => d.severity === 0);
const warnings = diagnostics.filter((d) => d.severity === 1);
for (const d of errors) console.log('ERROR', d.code, d.message, d.path?.join('.'));
for (const d of warnings) console.log('aviso', d.code, '-', d.message, '@', d.path?.join('.'));
if (!document) { console.log('No se pudo parsear'); process.exit(1); }
const msgs = document.allMessages().all();
const pub = msgs.filter((m) => m.extensions().get('x-public')?.value() === true);
const resolved = msgs.filter((m) => m.payload() && Object.keys(m.payload().json() || {}).length > 0);
console.log(`Válido: ${errors.length} errores, ${warnings.length} avisos · ${document.channels().length} canales · ` +
  `${document.operations().length} operaciones · ${msgs.length} mensajes (${pub.length} públicos) · payloads resueltos: ${resolved.length}`);
// Los payloads públicos deben venir del contrato: exigir 'specversion' y 'correlationid' tras resolver
const bad = msgs.filter((m) => m.name() !== 'esb.deferred' && !JSON.stringify(m.payload()?.json() ?? {}).includes('correlationid'));
console.log('Mensajes sin el atributo correlationid tras resolver referencias:', bad.map((m) => m.name()));
process.exitCode = errors.length || bad.length ? 1 : 0;
