// Verifica contract/gateway.graphql (V2.1, paso 8): 1) el SDL es válido; 2) no rompe la base del Reto 1
// (findBreakingChanges contra el schema de vuelos-graphql.yaml); 3) cada "→ MS.<servicio> <operationId>" existe en el
// contrato de ese MS de respuesta.
// Uso: npm i graphql@16.9.0 js-yaml@4.1.0 en una carpeta aparte; generar los bundles con
//   npx @redocly/cli@2.11.0 bundle ms-<servicio>.openapi.yaml --dereferenced --ext json -o <bundles>/ms-<servicio>.json
// y ejecutar: node verificar_gateway_graphql.cjs <carpeta contract> <carpeta bundles>
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { buildSchema, findBreakingChanges, findDangerousChanges } = require('graphql');

const contractDir = process.argv[2];
const bundlesDir = process.argv[3];
const gatewaySdl = fs.readFileSync(path.join(contractDir, 'gateway.graphql'), 'utf8');
const baseSdl = yaml.load(fs.readFileSync(path.join(contractDir, 'vuelos-graphql.yaml'), 'utf8')).schema;

const base = buildSchema(baseSdl);
const gateway = buildSchema(gatewaySdl);
const q = gateway.getQueryType().getFields(), m = gateway.getMutationType().getFields();
console.log(`1) gateway.graphql válido: ${Object.keys(q).length} queries, ${Object.keys(m).length} mutations, ` +
  `${Object.keys(gateway.getTypeMap()).filter((t) => !t.startsWith('__')).length} tipos`);

const breaking = findBreakingChanges(base, gateway);
const dangerous = findDangerousChanges(base, gateway);
console.log(`2) Frente a la base del Reto 1: ${breaking.length} cambios incompatibles, ${dangerous.length} cambios "peligrosos" (aditivos)`);
for (const c of breaking) console.log('   INCOMPATIBLE:', c.type, '-', c.description);
for (const c of dangerous) console.log('   aditivo:', c.type, '-', c.description);

// 3) cada "→ MS.X operationId" debe existir en el contrato de ese MS
const files = { 'MS.Vuelos': 'ms-vuelos', 'MS.Reservas': 'ms-reservas', 'MS.Postventa': 'ms-postventa', 'MS.Clientes': 'ms-clientes', 'MS.Admin': 'ms-admin' };
const ops = {};
for (const [ms, f] of Object.entries(files)) {
  const doc = JSON.parse(fs.readFileSync(path.join(bundlesDir, f + '.json'), 'utf8'));
  ops[ms] = new Set(Object.values(doc.paths).flatMap((it) => Object.values(it)).map((o) => o && o.operationId).filter(Boolean));
}
const refs = [...gatewaySdl.matchAll(/→ (MS\.[A-Za-z]+) ([A-Za-z]+)/g)];
const missing = refs.filter(([, ms, op]) => !ops[ms] || !ops[ms].has(op));
console.log(`3) Referencias "→ MS.X operación": ${refs.length}, inexistentes: ${missing.length}`);
for (const [, ms, op] of missing) console.log('   NO EXISTE:', ms, op);
process.exitCode = breaking.length || missing.length ? 1 : 0;
