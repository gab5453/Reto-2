# PLAN — Red nacional: las 24 provincias del Ecuador

| | |
|---|---|
| Fecha | 08/11/2026 |
| Estado | **P-1 hecha (08/11)**: desplegada, 24 rutas creadas en la nube y verificada (ver `CAMBIOS.md`). Falta publicar la web y el commit |
| Objetivo | Que la red sea más local: cada provincia del Ecuador tiene su capital disponible para crear rutas (haya o no aeropuerto real), y Quito vuela a todas |
| Qué NO cambia | El contrato del grupo (solo exige códigos de 3 letras), la lógica del horario y la red semilla con la que arranca Schedule |
| Costo | **US$0** |

## 1. Ciudades nuevas (24)

Pichincha (Quito, UIO), Guayas (Guayaquil, GYE) y Azuay (Cuenca, CUE) ya estaban. Se agregan las otras 21 capitales y, donde
el aeropuerto real no está en la capital, también ese aeropuerto (D-P2).

| Provincia | Ciudad | Código | Tipo |
|---|---|---|---|
| Bolívar | Guaranda | GDA | Capital · código propio (sin aeropuerto) |
| Cañar | Azogues | AZG | Capital · código propio |
| Carchi | Tulcán | TUA | Capital · aeropuerto real |
| Chimborazo | Riobamba | RBA | Capital · código propio |
| Cotopaxi | Latacunga | LTX | Capital · aeropuerto real |
| El Oro | Machala | MCH | Capital · aeropuerto real (cerrado hoy) |
| El Oro | Santa Rosa | ETR | Aeropuerto real de la provincia |
| Esmeraldas | Esmeraldas | ESM | Capital · aeropuerto real |
| Galápagos | Puerto Baquerizo Moreno | SCY | Capital · aeropuerto real · **UTC−6** |
| Imbabura | Ibarra | IBR | Capital · código propio |
| Loja | Loja | LOH | Capital · aeropuerto real (en Catamayo) |
| Los Ríos | Babahoyo | BHO | Capital · código propio |
| Manabí | Portoviejo | PVO | Capital · aeropuerto real (cerrado hoy) |
| Manabí | Manta | MEC | Aeropuerto real de la provincia |
| Morona Santiago | Macas | XMS | Capital · aeropuerto real |
| Napo | Tena | TNW | Capital · aeropuerto real |
| Orellana | Francisco de Orellana (Coca) | OCC | Capital · aeropuerto real |
| Pastaza | Puyo | PTZ | Capital · aeropuerto real (en Shell) |
| Santa Elena | Santa Elena | STE | Capital · código propio |
| Santa Elena | Salinas | SNC | Aeropuerto real de la provincia |
| Santo Domingo de los Tsáchilas | Santo Domingo | SDT | Capital · código propio |
| Sucumbíos | Nueva Loja | LGQ | Capital · aeropuerto real (Lago Agrio) |
| Tungurahua | Ambato | ATF | Capital · aeropuerto real |
| Zamora Chinchipe | Zamora | ZMR | Capital · código propio |

Los códigos propios no son IATA oficiales y pueden coincidir con aeropuertos de otros países; dentro de la red no hay conflicto.
Las rutas muy cortas (p. ej. Latacunga–Ambato, ~40 km) se aceptan: es una red ficticia.

## 2. Cambios

- **`packages/shared` (catálogo):** las 24 ciudades con coordenadas, huso horario (Galápagos UTC−6) y provincia.
- **MS.G.Schedule:** la red «todos con todos» de las pruebas del motor (`generateRoutes`) queda fija en los 10 aeropuertos
  originales: su numeración de vuelos y sus franjas solo alcanzan para ~10. La red real (semilla + rutas del panel) no cambia.
- **Web:** las mismas ciudades en `data/airports.ts`; los selectores agrupan «Ecuador» (con la provincia) e «Internacional».
- **Rutas (D-P3):** en la nube, desde el panel (API de administración), **Quito → cada ciudad ecuatoriana**, diarias, ida por la
  mañana con horas escalonadas y vuelta el mismo día. El sistema agrega un avión por ruta con base en Quito.
- **Booking:** verá las ciudades nuevas en las búsquedas; conviene avisarles (no cambia el contrato).

## 3. Decisiones (08/11)

| # | Decisión | Resultado |
|---|---|---|
| D-P1 | Códigos de las ciudades | Los de la tabla |
| D-P2 | Capital vs. aeropuerto real | Quito, Guayaquil y Cuenca se quedan; se agregan las capitales **y** los aeropuertos reales que no están en la capital (Manta, Santa Rosa, Salinas) |
| D-P3 | Rutas | Desde Quito a todas las ciudades del Ecuador, diarias, ida y vuelta el mismo día |

## 4. Fase P-1

Catálogo, Schedule, web, pruebas, despliegue, creación de las rutas en la nube y recorrido en Edge (buscar un vuelo Quito →
Galápagos y Quito → Guaranda; ver las rutas en el panel). Registro en `CAMBIOS.md`.
