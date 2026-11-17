import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { guardarJson } from "./bucle.mjs";

export const ID_SESION = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ID_EJECUCION = /^\d{13}-[a-f0-9-]{36}$/;

export async function leerJson(ruta) {
  return JSON.parse(await readFile(ruta, "utf8"));
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

export async function auditar(proyecto, datos, trabajo, signal) {
  const id = `${Date.now()}-${randomUUID()}`;
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
  } catch (error) {
    const estado = signal?.aborted ? "cancelado" : error.decision === "denegado" ? "bloqueado" : "error";
    await guardarJson(join(raiz, "resultado.json"), {
      estado, decision: estado === "bloqueado" ? "denegado" : "autorizado",
      fin: new Date().toISOString(), motivo: error.publico || (estado === "cancelado" ? "Turno cancelado" : "Error de ejecución"),
    });
    throw error;
  }
  await guardarJson(join(raiz, "resultado.json"), {
    estado: "completo", decision: "autorizado", fin: new Date().toISOString(),
    evidencia: resultado?.evidencia,
  });
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
