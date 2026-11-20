import assert from "node:assert/strict";
import {resolve} from "node:path";
import {crearCredencialesOpenAI} from "../credenciales-openai.mjs";
import {entorno} from "../entorno.mjs";
import {inspeccionar} from "../inspeccion.mjs";
import {probarModeloInspeccion, resolverModeloInspeccion} from "../modelo-inspeccion.mjs";
import {leerAuditoria, leerControlWifi, localizarProyecto} from "../proyecto.mjs";

const [carpeta, nombre, modo, ...resto] = process.argv.slice(2);
if (!carpeta || !nombre || (modo && modo !== "--usb") || resto.length) {
  throw new Error("Uso: node tests/inspeccion-real.mjs <proyecto autorizado> <interfaz> [--usb]");
}
const proyecto = await localizarProyecto(resolve(carpeta));
assert.ok(proyecto, "El directorio debe contener un proyecto Harwiff.");
const perfil = await entorno("adaptadores-perfil", undefined, {soloLectura: true});
const dispositivo = perfil.devices.find(d => d.phys.some(p => p.interfaces.some(i => i.ifname === nombre)));
assert.equal(dispositivo?.bus, modo === "--usb" ? "usb" : "pci", "El bus no corresponde al perfil de prueba.");
if (modo !== "--usb") {
  const radio = dispositivo.phys.find(p => p.interfaces.some(i => i.ifname === nombre));
  assert.equal(radio.connectivity.criticality, "critical", "M1 requiere que la tarjeta interna sostenga una ruta principal.");
}
const control = await leerControlWifi(proyecto);
assert.ok(control.scope.allowedBssids.length || control.scope.allowedSsids.length,
  "La prueba de asociación requiere una red autorizada por el operador.");

const proveedor = process.env.HARWIFF_LLM_PROVIDER ?? proyecto.config.llm?.inspeccion?.provider ?? proyecto.config.llm?.proveedor;
const credenciales = proveedor === "openai" ? await crearCredencialesOpenAI().resolver() : undefined;
const conexion = await resolverModeloInspeccion(proyecto.config, credenciales?.entorno);
const modelo = await probarModeloInspeccion(conexion, AbortSignal.timeout(30000));
const casos = [
  {
    objetivo: "¿Cuántos radios Wi-Fi puedes observar y qué buses identificas?",
    campos: [/Radios Wi‑Fi detectados/, /Bus/], red: false, operacion: "consultar_adaptadores",
  },
  {
    objetivo: "Describe la asociación de la interfaz elegida y qué puedes comprobar sobre IPv6.",
    campos: [/Hecho · Asociación informada/, /IPv6/], red: true, nombre, operacion: "inspeccionar_enlace",
  },
  {
    objetivo: "Identifica el bus del radio seleccionado y comprueba si ese radio sostiene una ruta por defecto IPv4.",
    campos: [/Bus \(p1\)/, /Ruta por defecto IPv4/], red: false, nombre, operacion: "inspeccionar_enlace",
  },
];
const rondas = modo === "--usb" ? 10 : 9;
let pasa = 0;
const duraciones = [];
for (let i = 0; i < rondas; i++) {
  const {campos, operacion, ...opciones} = casos[i % casos.length];
  const resultado = await inspeccionar({proyecto, conexion, ...opciones, comprobarModelo: async () => modelo});
  const auditoriaTurno = await leerAuditoria(proyecto.raiz, resultado.turnId);
  assert.equal(auditoriaTurno.origen, "inspeccion");
  const texto = resultado.lineas.join("\n");
  const referencias = [...new Set([...texto.matchAll(/([0-9]{13}-[0-9a-f-]{36})#\d+/g)].map(match => match[1]))];
  const registros = await Promise.all(referencias.map(id => leerAuditoria(proyecto.raiz, id)));
  assert.ok(registros.every(item => item.padre === resultado.turnId && item.estado === "completo" && item.evidencia?.origen === "host_readonly"));
  assert.ok(control.scope.allowedBssids.every(bssid => !texto.includes(bssid)), "La salida contiene un BSSID autorizado sin depurar.");
  const oraculo = resultado.motivo === "completed" && resultado.metricas.solicitudes >= 2 &&
    campos.every(patron => patron.test(texto)) && registros.some(item => item.operacion === operacion);
  if (oraculo) pasa++;
  duraciones.push(resultado.metricas.duracionMs);
  console.log(JSON.stringify({corrida: i + 1, objetivo: i % casos.length, motivo: resultado.motivo,
    oraculo, auditoria: resultado.turnId, ...resultado.metricas}));
}
duraciones.sort((a, b) => a - b);
const minimo = modo === "--usb" ? 9 : 8;
console.log(JSON.stringify({bus: dispositivo.bus, proveedor: conexion.modelo.provider, modelo, corridas: rondas, pasa,
  latenciaMs: {min: duraciones[0], mediana: (duraciones[Math.floor((rondas - 1) / 2)] + duraciones[Math.floor(rondas / 2)]) / 2,
    max: duraciones.at(-1)},
  revisionHumana: "Pendiente: interpretar las hipótesis y comparar la conectividad y los eventos del host."}));
if (pasa < minimo) process.exitCode = 1;
