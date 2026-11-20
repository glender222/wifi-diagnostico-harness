import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import { guardarJson } from "./bucle.mjs";
import { conBloqueoProyecto, entorno } from "./entorno.mjs";

export const CLIENTES = ["demo", "azure-foundry", "chatgpt", "opencode"];
export const ID_SESION = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const ID_EJECUCION = /^\d{13}-[a-f0-9-]{36}$/;

export function resumenControlWifi(control) {
  const adaptador = control?.adapter;
  const alcance = control?.scope;
  const filtros = [
    [alcance?.allowedBssids.length, "BSSID"],
    [alcance?.allowedSsids.length, "SSID"],
    [alcance?.allowedChannels.length, "canal(es)"],
  ].filter(([cantidad]) => cantidad).map(([cantidad, tipo]) => `${cantidad} ${tipo}`);
  const preflight = control?.preflight;
  const nombre = String(adaptador?.name ?? (adaptador ? "guardado" : "ninguno")).replace(/[\x00-\x1f\x7f-\x9f]/g, "");
  return `Adaptador: ${nombre} | Alcance: ${filtros.join(", ") || "pendiente"} | Preflight: ${preflight ? (preflight.ok ? "OK" : "Bloqueado") : "Pendiente"}`;
}

export async function leerJson(ruta) {
  return JSON.parse(await readFile(ruta, "utf8"));
}

async function infoRuta(ruta) {
  return lstat(ruta).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
}

export async function localizarProyecto(carpeta) {
  const interno = join(carpeta, ".harwiff");
  const bases = (await infoRuta(interno))?.isDirectory() ? [interno, carpeta] : [carpeta];
  for (const raiz of bases) {
    const archivo = join(raiz, "harness.json");
    if (!(await infoRuta(archivo))?.isFile()) continue;
    let config;
    try {
      config = await leerJson(archivo);
    } catch (error) {
      if (error.code === "ENOENT" || (error instanceof SyntaxError && raiz === carpeta)) continue;
      if (error instanceof SyntaxError) throw new Error(`Revisa el manifiesto de Harwiff en ${archivo}.`);
      throw error;
    }
    if (config?.esquema === "wifi-proyecto/v1") {
      if (!CLIENTES.includes(config.cliente)) throw new Error(`Cliente desconocido en ${archivo}.`);
      return { raiz, archivo, config };
    }
    if (raiz === interno) throw new Error(`El manifiesto de Harwiff en ${archivo} tiene un formato desconocido.`);
  }
  return undefined;
}

export async function leerControlWifi(proyecto) {
  const ruta = join(proyecto.raiz, "control-wifi.json");
  const info = await infoRuta(ruta);
  if (!info) {
    const id = proyecto.config?.adaptador;
    return {
      projectId: null,
      revision: 0,
      adapter: typeof id === "string" ? { id, name: null, mode: "sandbox" } : null,
      scope: { allowedBssids: [], allowedSsids: [], allowedChannels: [], maxIterations: 8 },
      preflight: null,
      snapshot: null,
    };
  }
  try {
    if (!info.isFile()) throw new TypeError();
    const estado = await leerJson(ruta);
    if (estado?.esquema !== "harwiff-control-wifi/v1" || typeof estado.projectId !== "string"
        || !["allowedBssids", "allowedSsids", "allowedChannels"].every((campo) => Array.isArray(estado.scope?.[campo]))
        || (estado.revision !== undefined && (!Number.isSafeInteger(estado.revision) || estado.revision < 0))
        || (estado.adapter !== null && typeof estado.adapter?.id !== "string")) {
      throw new TypeError();
    }
    return { revision: 0, ...estado };
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) {
      throw new Error("Revisa control-wifi.json. El estado Wi-Fi del proyecto tiene un formato inválido.");
    }
    throw error;
  }
}

async function guardarControlWifi(proyecto, estado) {
  await guardarJson(join(proyecto.raiz, "control-wifi.json"), { ...estado, esquema: "harwiff-control-wifi/v1" });
}

export function hashAlcance({ projectId, adapter, scope }) {
  const ordenar = (valores) => [...new Set(valores)].sort();
  const datos = [projectId, adapter?.id, adapter?.mode, ordenar(scope.allowedBssids),
    ordenar(scope.allowedSsids), ordenar(scope.allowedChannels), scope.maxIterations];
  return createHash("sha256").update(JSON.stringify(datos)).digest("hex");
}

function revisarAlcance(anterior, estado) {
  return { ...estado, revision: anterior.revision + Number(hashAlcance(anterior) !== hashAlcance(estado)) };
}

function snapshotWifi(projectId, adapter, scope) {
  return Object.freeze({
    projectId,
    adapter: Object.freeze({ id: adapter.id, name: adapter.name, mode: adapter.mode }),
    scope: Object.freeze({
      allowedBssids: Object.freeze([...scope.allowedBssids]),
      allowedSsids: Object.freeze([...scope.allowedSsids]),
      allowedChannels: Object.freeze([...scope.allowedChannels]),
      maxIterations: scope.maxIterations,
    }),
    preflightPassed: true,
  });
}

async function validarControlWifi(estado, observed) {
  const { adapter, scope } = estado;
  if (!adapter) return { estado: { ...estado, preflight: null, snapshot: null }, lockedBySession: null };
  const resultado = await entorno("preflight", { id: adapter.id, name: adapter.name, scope, observed }).catch((error) => ({
    preflight: { ok: false, errors: [error.message], capabilities: [] },
  }));
  const actual = resultado.adapter;
  const seleccion = actual ? { id: actual.id, name: actual.name, mode: actual.mode } : adapter;
  const alcance = resultado.scope ?? scope;
  return {
    estado: {
      ...estado,
      adapter: seleccion,
      scope: alcance,
      preflight: resultado.preflight,
      snapshot: resultado.preflight.ok ? snapshotWifi(estado.projectId, seleccion, alcance) : null,
    },
    code: resultado.code ?? null,
    lockedBySession: actual?.lockedBySession ?? null,
  };
}

function errorPreflight(preflight, code) {
  return Object.assign(new Error(preflight.errors.join(" ")), { preflight, code });
}

export async function validarScopeSnapshot(project) {
  const actual = await leerControlWifi(project);
  const { estado } = await validarControlWifi(actual);
  if (estado.snapshot) return { snapshot: estado.snapshot, capabilities: estado.preflight.capabilities };
  throw errorPreflight(estado.preflight ?? {
    ok: false, errors: ["Selecciona un adaptador con /adaptador usar."], capabilities: [],
  });
}

export async function buildScopeSnapshot(project) {
  return (await validarScopeSnapshot(project)).snapshot;
}

export async function guardarAlcance(proyecto, datos) {
  const scope = await entorno("alcance", datos);
  return conBloqueoProyecto(proyecto.raiz, async () => {
    const anterior = await leerControlWifi(proyecto);
    const resultado = await validarControlWifi({ ...anterior, projectId: anterior.projectId ?? randomUUID(), scope });
    const estado = revisarAlcance(anterior, resultado.estado);
    const huboCambio = hashAlcance({ ...anterior, scope: estado.scope }) !== hashAlcance(anterior);
    await guardarCambioConfiguracion(proyecto.raiz, huboCambio ? ["alcance"] : [], () => guardarControlWifi(proyecto, estado));
    return estado;
  });
}

export async function usarAdaptador(proyecto, name, id, observed) {
  return conBloqueoProyecto(proyecto.raiz, async () => {
    const anterior = await leerControlWifi(proyecto);
    const resultado = await validarControlWifi({ ...anterior, adapter: { id, name } }, observed);
    const estado = revisarAlcance(anterior, resultado.estado);
    if (!estado.snapshot) throw errorPreflight(estado.preflight, resultado.code);
    const cambio = estado.adapter.id !== anterior.adapter?.id || estado.adapter.mode !== anterior.adapter?.mode;
    await guardarCambioConfiguracion(proyecto.raiz, cambio ? ["adaptador"] : [], () => guardarControlWifi(proyecto, estado));
    return estado;
  });
}

export async function inspeccionarControlWifi(proyecto) {
  return conBloqueoProyecto(proyecto.raiz, async () => {
    const anterior = await leerControlWifi(proyecto);
    const resultado = await validarControlWifi(anterior);
    if (anterior.projectId && JSON.stringify(resultado.estado) !== JSON.stringify(anterior)) {
      await guardarControlWifi(proyecto, resultado.estado);
    }
    return resultado;
  });
}

const INFRAESTRUCTURA = new Set(["node_modules", "__pycache__"]);
const DATOS_PLANOS = new Set(["agentes", "auditoria", "harness", "informes", "sesiones"]);

export async function descubrirProyectos(ruta, profundidad) {
  let entradas;
  try {
    if (!(await lstat(ruta)).isDirectory()) throw new Error("Elige una carpeta real.");
    entradas = await readdir(ruta, { withFileTypes: true });
  } catch {
    throw new Error(`No se puede leer la carpeta ${ruta}.`);
  }
  const proyectos = [];
  const avisos = [];

  async function revisar(carpeta, nivel, contenido) {
    let proyecto;
    try {
      proyecto = await localizarProyecto(carpeta);
      if (proyecto) proyectos.push({ nombre: basename(carpeta), ruta: carpeta, cliente: proyecto.config.cliente });
    } catch (error) {
      avisos.push({ ruta: carpeta, motivo: error.message });
    }
    if (nivel === profundidad) return;
    for (const entrada of contenido) {
      if (!entrada.isDirectory() || entrada.name.startsWith(".") || INFRAESTRUCTURA.has(entrada.name)
          || (proyecto?.raiz === carpeta && DATOS_PLANOS.has(entrada.name))) continue;
      const hija = join(carpeta, entrada.name);
      try {
        if (!(await lstat(hija)).isDirectory()) continue;
        await revisar(hija, nivel + 1, await readdir(hija, { withFileTypes: true }));
      } catch {
        avisos.push({ ruta: hija, motivo: "No se puede leer la carpeta." });
      }
    }
  }

  await revisar(ruta, 0, entradas);
  const porRuta = (a, b) => a.ruta < b.ruta ? -1 : a.ruta > b.ruta ? 1 : 0;
  return { ruta, proyectos: proyectos.sort(porRuta), avisos: avisos.sort(porRuta) };
}

export async function directorios(ruta) {
  try {
    return (await readdir(ruta, { withFileTypes: true })).filter((entrada) => entrada.isDirectory())
      .map((entrada) => entrada.name).sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export const crearIdAuditoria = () => `${Date.now()}-${randomUUID()}`;

export async function auditar(proyecto, datos, trabajo, signal, detallesResultado, id = crearIdAuditoria(), confirmar = cerrar => cerrar()) {
  if (!ID_EJECUCION.test(id)) throw new Error("ID de auditoría inválido.");
  const raiz = join(proyecto, "auditoria", id);
  await mkdir(raiz, { recursive: true, mode: 0o700 });
  const inicio = new Date().toISOString();
  await guardarJson(join(raiz, "solicitud.json"), {
    esquema: "harwiff-auditoria/v1", id, inicio, ...datos,
  });

  let resultado;
  try {
    signal?.throwIfAborted();
    resultado = await trabajo(id);
    await confirmar((datos = {}) => guardarJson(join(raiz, "resultado.json"), {
      estado: "completo", decision: "autorizado", fin: new Date().toISOString(),
      evidencia: resultado?.evidencia,
      ...detallesResultado?.({ id, estado: "completo", resultado }),
      ...datos,
    }));
  } catch (error) {
    const estado = signal?.aborted ? "cancelado" : error.decision === "denegado" ? "bloqueado" : "error";
    await guardarJson(join(raiz, "resultado.json"), {
      estado, decision: estado === "bloqueado" ? "denegado" : "autorizado",
      fin: new Date().toISOString(), motivo: error.publico || (estado === "cancelado" ? "Turno cancelado" : "Error de ejecución"),
      ...detallesResultado?.({ id, estado, error }),
    });
    throw error;
  }
  return id;
}

export async function leerAuditoria(proyecto, id) {
  if (!ID_EJECUCION.test(id)) throw new Error("ID de auditoría inválido.");
  const raiz = join(proyecto, "auditoria", id);
  if (!(await lstat(raiz)).isDirectory()) throw new Error("Ejecución inválida.");
  const solicitud = await leerJson(join(raiz, "solicitud.json"));
  const resultado = await leerJson(join(raiz, "resultado.json")).catch((error) => {
    if (error.code === "ENOENT") return { estado: "pendiente de cierre" };
    throw error;
  });
  return { ...solicitud, ...resultado };
}

export async function idsAuditoria(proyecto) {
  return (await directorios(join(proyecto, "auditoria"))).filter((id) => ID_EJECUCION.test(id));
}

const AJUSTES = new Map([
  ["proveedor", "proveedor LLM"], ["modelo", "modelo predeterminado"], ["foundry", "configuración de Foundry"],
  ["sandbox", "puerto de OpenSandbox"], ["alcance", "alcance"], ["adaptador", "adaptador"],
]);

export async function guardarCambioConfiguracion(raiz, campos, guardar) {
  if (!campos.length) return guardar();
  return auditar(raiz, { origen: "usuario", operacion: "configuracion", campos }, async () => { await guardar(); });
}

export async function leerActividadProyecto(raiz) {
  const guardados = await idsAuditoria(raiz).catch((error) => {
    if (error.code === "EACCES" || error.code === "EPERM") return [];
    throw error;
  });
  const ids = guardados.slice(-24).reverse();
  const actividad = [];
  for (let i = 0; i < ids.length && actividad.length < 6; i += 6) {
    const lote = await Promise.all(ids.slice(i, i + 6).map(async (id) => {
      const registro = await leerAuditoria(raiz, id).catch(() => undefined);
      if (registro?.esquema !== "harwiff-auditoria/v1" || registro.id !== id || registro.padre ||
          typeof registro.operacion !== "string" || !/^[a-z][a-z0-9_]{0,39}$/.test(registro.operacion) ||
          !["completo", "bloqueado", "error", "cancelado", "pendiente de cierre"].includes(registro.estado)) return;
      const fecha = new Date(Number(id.slice(0, 13))).toISOString().replace("T", " ").slice(0, 16);
      const campos = Array.isArray(registro.campos) ? registro.campos.map((campo) => AJUSTES.get(campo)).filter(Boolean) : [];
      const etiqueta = registro.operacion === "configuracion" ? `Configuración${campos.length ? " · " + campos.join(", ") : ""}`
        : registro.operacion === "diagnostico" ? "Diagnóstico"
          : registro.operacion === "sesion_mock" || registro.operacion === "turno" ? "Turno del agente"
            : registro.operacion;
      return `${fecha} UTC · ${etiqueta} · ${registro.estado} · /auditoria ${id}`;
    }));
    actividad.push(...lote.filter(Boolean));
  }
  return actividad.slice(0, 6).reverse();
}

export async function guardarInforme(proyecto, id, informe) {
  const referencia = `informes/${id}.json`;
  const ruta = join(proyecto, referencia);
  await mkdir(join(proyecto, "informes"), { recursive: true, mode: 0o700 });
  await guardarJson(ruta, informe);
  const sha256 = createHash("sha256").update(await readFile(ruta)).digest("hex");
  return { referencia, sha256, origen: informe.origen };
}

const indicadores = {
  interfaces_wifi: Number.isSafeInteger,
  conectada: (valor) => typeof valor === "boolean",
  senal_dbm: (valor) => valor === null || (Number.isInteger(valor) && valor >= -127 && valor < 0),
  ipv4_no_link_local: (valor) => typeof valor === "boolean",
  ipv6_no_link_local: (valor) => typeof valor === "boolean",
  gateway_ipv4: (valor) => typeof valor === "boolean",
  gateway_ipv6: (valor) => typeof valor === "boolean",
  dns_wifi: (valor) => typeof valor === "boolean",
};

function depurar(informe) {
  if (informe?.esquema !== "wifi-diagnostico/v1" || !["demo", "networkmanager"].includes(informe.origen)) return null;
  const observaciones = Object.fromEntries(Object.entries(indicadores).flatMap(([clave, valida]) => {
    const valor = informe.observaciones?.[clave];
    return valida(valor) ? [[clave, valor]] : [];
  }));
  return { origen: informe.origen, observaciones };
}

export async function informesAgente(proyecto) {
  const archivos = [];
  async function agregar(ruta, historico) {
    try {
      const info = await lstat(ruta);
      if (!info.isDirectory()) return;
      for (const entrada of await readdir(ruta, { withFileTypes: true })) {
        if (entrada.isFile() && /^[a-zA-Z0-9_-]+\.json$/.test(entrada.name)) {
          archivos.push({ ruta: join(ruta, entrada.name), id: entrada.name.slice(0, -5), historico });
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  await agregar(join(proyecto, "informes"), false);
  for (const sesion of await directorios(join(proyecto, "sesiones"))) {
    await agregar(join(proyecto, "sesiones", sesion, "informes"), true);
  }
  const resultados = [];
  for (const archivo of archivos.sort((a, b) => b.id.localeCompare(a.id)).slice(0, 12)) {
    const info = await lstat(archivo.ruta);
    if (!info.isFile() || info.size > 64 * 1024) continue;
    const informe = await leerJson(archivo.ruta).catch((error) => {
      if (error instanceof SyntaxError || error.code === "ENOENT") return null;
      throw error;
    });
    const contenido = depurar(informe);
    if (contenido) resultados.push({ id: archivo.id, historico: archivo.historico, ...contenido });
  }
  return resultados;
}
