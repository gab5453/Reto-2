"""Verifica que las 30 operaciones del contrato de Vuelos v2 aparezcan UNA sola vez entre los MS de respuesta, en el MS que
indica su `x-microservice`, y con una definición IDÉNTICA a la del contrato del grupo (verificación de V2.1, PLAN.md §6).

Uso (desde contract/):
    python tools/verificar_operaciones_v2.py
Requiere Node (npx @redocly/cli) para resolver las referencias.
"""
import collections
import json
import subprocess
import sys
import tempfile
from pathlib import Path

METHODS = ("get", "post", "put", "patch", "delete")
RESPUESTA = {"ms-vuelos": "MS.Vuelos", "ms-reservas": "MS.Reservas", "ms-postventa": "MS.Postventa",
             "ms-clientes": "MS.Clientes", "ms-admin": "MS.Admin"}


def bundle(source: str, out_dir: Path) -> dict:
    out = out_dir / (Path(source).stem + ".json")
    subprocess.run(f'npx --yes @redocly/cli@2.11.0 bundle {source} --dereferenced --ext json -o "{out}"',
                   shell=True, check=True, capture_output=True)
    return json.loads(out.read_text(encoding="utf-8"))


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        contract = bundle("vuelos-openapi-v2.yaml", tmp_dir)
        expected = {op["operationId"]: (op["x-microservice"], p, m, op)
                    for p, item in contract["paths"].items() for m, op in item.items() if m in METHODS}
        found = collections.defaultdict(list)
        own = collections.Counter()
        for name, ms in RESPUESTA.items():
            doc = bundle(f"{name}.openapi.yaml", tmp_dir)
            for p, item in doc["paths"].items():
                for m, op in item.items():
                    if m not in METHODS:
                        continue
                    if op.get("operationId") in expected and p.startswith("/vuelos/"):
                        found[op["operationId"]].append((ms, p, m, op))
                    else:
                        own[ms] += 1
    errors = 0
    for oid, (ms, p, m, op) in expected.items():
        hits = found.get(oid, [])
        if len(hits) != 1:
            print(f"FALLA {oid}: aparece {len(hits)} veces")
            errors += 1
            continue
        hms, hp, hm, hop = hits[0]
        if (hms, hp, hm) != (ms, p, m) or json.dumps(hop, sort_keys=True) != json.dumps(op, sort_keys=True):
            print(f"FALLA {oid}: está en {hms} {hm.upper()} {hp} o su definición cambió")
            errors += 1
    print(f"Operaciones del contrato: {len(expected)} · correctas: {len(expected) - errors}")
    print("Por MS:", dict(collections.Counter(found[o][0][0] for o in found)))
    print("Operaciones propias:", dict(own))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
