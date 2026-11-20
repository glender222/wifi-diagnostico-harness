import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { ejecutarPi, guardarJson, modeloFoundry, MODELO_DEMO } from "./bucle.mjs";
import { contextoHistorico, leerHistorial, leerResultadoAuditado, recuperarTurno, resultadoTurno, textoVisible } from "./historial-agente.mjs";
import { conBloqueoProyecto, crearBrokerLocal, entorno, depurarInventario } from "./entorno.mjs";
import { authorize, cargarObjetivosMock, HERRAMIENTAS, parametrosAuditables } from "./policy.mjs";
import { MENSAJES_OPENAI, seguirOpenAI, validarModeloOpenAI } from "./proveedor-openai.mjs";
import { auditar, crearIdAuditoria, hashAlcance, ID_EJECUCION, leerControlWifi, leerJson, validarScopeSnapshot } from "./proyecto.mjs";

const ESQUEMA = "harwiff-agent-session/v1";
const ACTIVO = new Set(["created", "running"]);
const DENEGACIONES_BROKER = new Set(["invalid_request", "invalid_scope", "adapter_denied", "unknown_tool",
  "invalid_arguments", "target_denied", "evidence_denied"]);
const TIEMPO_SESION = 120_000;
const TIEMPO_BROKER = 5_000;
const SOLO_CONSULTA = new Set(["cancelled", "interrupted", "timeout", "scope_changed"]);
const simulador = crearBrokerLocal("fixture");
const brokerMock = async (solicitud, signal) => (await simulador.execute(solicitud, signal, TIEMPO_BROKER)).resultado;
const consultarInventario = (signal) => entorno("adaptadores-perfil", undefined, { signal, tiempo: TIEMPO_BROKER });

const MOTIVOS = {
  ...MENSAJES_OPENAI,
  scope_changed: "El alcance cambió durante la sesión.",
  interrupted: "Sesión interrumpida. Se conservó la evidencia guardada.",
  tool_limit: "Límite de herramientas alcanzado. Resultado parcial.",
  iteration_limit: "Límite de solicitudes alcanzado. Resultado parcial.",
  cancelled: "Sesión cancelada.",
  timeout: "La sesión agotó el tiempo disponible.",
  provider_error: "El modelo interrumpió la ejecución.",
  session_error: "No se pudo completar la sesión.",
};

export const PROVEEDORES_AGENTE = ["openai", "azure-foundry"];

export function etiquetaProveedor(proveedor) {
  if (proveedor === "openai") return "OpenAI";
  if (proveedor === "azure-foundry") return "Azure Foundry";
  return proveedor === "demo" ? "Demo local · simulación" : "Sin modelo configurado";
}

class DecisionDenegada extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.decision = "denegado";
    this.publico = MOTIVOS[code] ?? code;
  }
}

class FinSesion extends Error {
  constructor(code) {
    super(MOTIVOS[code]);
    this.code = code;
    this.publico = this.message;
  }
}

function resumenHerramienta({ type, tool, result, parametros, autorizacion }) {
  const inventario = tool === "consultar_adaptadores";
  const objetivo = inventario ? "inventario físico del host · sesión mock" : parametros?.bssid ?? result?.bssid ?? "alcance mock";
  const decision = autorizacion?.decision ? ` · ${autorizacion.decision}` : "";
  if (!result) {
    const estado = type === "tool_progress" && !inventario ? "consultando broker mock" : "en ejecución";
    return `Herramienta · ${tool} · ${objetivo} · ${estado}`;
  }
  if (!result.ok) return `${tool} · ${objetivo}${decision} · ${result.code}`;
  if (inventario) return [tool, objetivo + decision, "consulta " + result.inventarioEstado].join(" · ");
  const resumen = tool === "observar_entorno" ? `${result.observaciones?.length ?? 0} punto(s) de acceso observado(s)`
    : tool === "inspeccionar_postura" ? `cifrado ${result.postura?.cifrado ?? "sin dato"} · PMF ${result.postura?.pmf ?? "sin dato"}`
      : `Hallazgo · ${result.categoria ?? "registrado"}`;
  const evidencia = result.findingId ? ` · hallazgo ${result.findingId} · evidencia ${result.evidenceId ?? parametros?.evidenceId ?? ""}`
    : result.evidenceId ? ` · evidencia ${result.evidenceId}` : "";
  return `${tool} · ${objetivo}${decision} · ${resumen}${evidencia}`;
}

function vistaSesion(dir, estado, turnos = [], parciales = []) {
  const bloques = new Map();
  const usuarios = new Map();
  const herramientas = new Map();
  let idTurno;
  function agregar(id, text, { markdown = false, tipo = "detalle", entrega } = {}) {
    bloques.set(id, { id, text: textoVisible(text), markdown, tipo, entrega, turno: idTurno });
  }
  for (const { id: turno, eventos } of turnos) {
    idTurno = turno;
    const tieneResumen = eventos.some(({ type }) => type === "summary") ||
      (turno === estado.turnId && parciales.some(({ resumen, text }) => resumen && text));
    for (const [indice, evento] of eventos.entries()) {
      const id = `${turno}/${indice}`;
      switch (evento.type) {
        case "start": agregar(id, `${etiquetaProveedor(evento.provider)}${evento.modelId ? ` · ${evento.modelId}` : ""} · Turno`);
          if (evento.resumenSolicitado === false && !tieneResumen) {
            agregar(id + "/summary", "Resumen oficial de OpenAI · no disponible (soporte sin confirmar).");
          }
          if (!eventos.some(({ type }) => type === "user")) agregar(id + "/goal", `Tú  ${evento.goal}`, { tipo: "mensaje" });
          break;
        case "user": {
          if (!usuarios.has(evento.messageId)) {
            usuarios.set(evento.messageId, evento.text);
            agregar(evento.messageId, `Tú  ${evento.text} · en cola`, { tipo: "mensaje", entrega: "queued" });
          }
          break;
        }
        case "user_state": {
          const texto = usuarios.get(evento.messageId);
          if (texto) agregar(evento.messageId, `Tú  ${texto}${evento.status === "not_sent" ? " · no enviado" : ""}`,
            { tipo: "mensaje", entrega: evento.status });
          break;
        }
        case "request": agregar(id, `Iteración ${evento.iteration}`); break;
        case "tool_call":
        case "tool_progress":
        case "tool_result": {
          const clave = `tool/${evento.llamadaId}`;
          const detalle = { ...herramientas.get(clave), ...evento };
          herramientas.set(clave, detalle);
          agregar(clave, resumenHerramienta(detalle));
          break;
        }
        case "response": agregar(evento.messageId ?? id, `**Harwiff**  ${evento.text}`, { markdown: true, tipo: "mensaje" }); break;
        case "summary": agregar(evento.messageId ?? id, `**Resumen de OpenAI**  ${evento.text}`, { markdown: true }); break;
        case "usage": {
          const { tokens, estado: uso, modelosDevueltos } = evento.consumo;
          const modelo = modelosDevueltos.length ? ` · modelo devuelto: ${modelosDevueltos.join(", ")}` : "";
          agregar(id, `Tokens OpenAI · ${tokens ? `entrada ${tokens.entrada}, salida ${tokens.salida}, total ${tokens.total} (${uso})`
            : "no disponibles"}${modelo}`);
          break;
        }
        case "end": agregar(id, MOTIVOS[evento.reason] ?? "Sesión completada."); break;
      }
    }
  }
  idTurno = estado.turnId;
  for (const { id, text, resumen } of parciales) {
    if (text) agregar(id, `**${resumen ? "Resumen de OpenAI" : "Harwiff"}**  ${text}`, { markdown: true, tipo: resumen ? "detalle" : "mensaje" });
  }
  if (!bloques.size) agregar("objetivo", estado.goal);
  if (estado.reason === "interrupted" && ![...bloques.values()].some(({ text }) => text === MOTIVOS.interrupted)) {
    agregar("interrumpida", MOTIVOS.interrupted);
  }
  const transcript = [...bloques.values()];
  return { id: estado.id, dir, modo: estado.provider, estado: estado.status, uso: estado.uso,
    modelId: estado.modelId, iniciado: true, autonoma: true, soloConsulta: SOLO_CONSULTA.has(estado.reason) ||
      (estado.provider === "azure-foundry" && (!estado.modelId || !estado.modelHost)),
    objetivo: textoVisible(estado.goal ?? ""), transcript, operaciones: [...herramientas.values()],
    mensajes: transcript.map(({ text }) => text.replace(/^\*\*(Harwiff|Resumen de OpenAI)\*\*/, "$1")),
    actividad: actividad(estado.lastEvent) };
}

function actividad(evento) {
  if (!evento) return "";
  if (evento.type === "request") return `iteración ${evento.iteration}`;
  if (evento.type === "agent_end") return "cerrando turno";
  if (evento.tool) return evento.tool;
  if (evento.type === "end") return evento.reason === "completed" ? "objetivo finalizado"
    : MOTIVOS[evento.reason] ?? "";
  return "";
}

export async function cargarSesionAutonoma(dir, datos, { soloResumen = false } = {}) {
  if (datos?.esquema !== ESQUEMA) return undefined;
  let estado = datos;
  let otraConsola = false;
  if (estado.id !== basename(dir) || (estado.turnId && !ID_EJECUCION.test(estado.turnId))) {
    throw new Error("La sesión autónoma guardada tiene identificadores inválidos.");
  }
  if (ACTIVO.has(estado.status) || estado.admisionAbierta) {
    await conBloqueoProyecto(dir, async () => {
      estado = await leerJson(join(dir, "sesion.json"));
      if (!ACTIVO.has(estado.status) && !estado.admisionAbierta) return;
      if (estado.id !== basename(dir) || (estado.turnId && !ID_EJECUCION.test(estado.turnId))) {
        throw new Error("La sesión autónoma guardada tiene identificadores inválidos.");
      }
      estado = await recuperarTurno(dir, estado);
      await guardarJson(join(dir, "sesion.json"), estado);
    }).catch((error) => {
      if (error.code !== "LOCK_BUSY") throw error;
      otraConsola = true;
    });
  }
  const item = vistaSesion(dir, estado, soloResumen ? [] : await leerHistorial(dir));
  if (soloResumen) item.historialPendiente = true;
  return otraConsola ? { ...item, soloConsulta: true, actividad: "activa en otra consola" } : item;
}

export function proveedorAgente(config) {
  const explicito = config?.llm?.proveedor;
  if (explicito === "demo" || explicito === null) return null;
  if (explicito !== undefined) {
    if (!PROVEEDORES_AGENTE.includes(explicito)) throw new Error("Proveedor de agente inválido en el manifiesto.");
    return explicito;
  }
  return config?.foundry || config?.cliente === "azure-foundry" ? "azure-foundry" : null;
}

async function configurarModelo(config, entorno, fetchFn, streamFn) {
  const provider = proveedorAgente(config);
  if (provider === "openai") {
    return { provider, ...await validarModeloOpenAI(config.llm.openaiModelId, { entorno, fetchFn }), streamFn };
  }
  if (provider === "azure-foundry") return { provider, ...modeloFoundry(config, entorno), streamFn };
  if (streamFn) return { provider: "demo", modelo: MODELO_DEMO, streamFn };
  throw new Error("Configura el proveedor con /connect y elige un modelo con /model.");
}

async function prepararAlcance(proyecto, esperado) {
  return conBloqueoProyecto(proyecto.raiz, async () => {
    const control = await leerControlWifi(proyecto);
    if (esperado && (control.revision !== esperado.scopeRevision || hashAlcance(control) !== esperado.scopeId)) {
      throw new FinSesion("scope_changed");
    }
    if (control.adapter && (control.adapter.id !== "mock" || control.adapter.mode !== "mock")) {
      throw new Error("Selecciona el adaptador mock para iniciar una sesión.");
    }
    const { snapshot, capabilities } = await validarScopeSnapshot(proyecto);
    return { snapshot, capabilities, scopeId: hashAlcance(snapshot), revision: control.revision };
  });
}

function contextoModelo({ snapshot: { adapter, scope }, capabilities, objetivos }) {
  return {
    adaptador: { id: adapter.id, nombre: adapter.name, modo: adapter.mode },
    objetivosAutorizados: [...objetivos.values()],
    canalesPermitidos: scope.allowedChannels,
    capacidades: capabilities.filter((capacidad) => capacidad === "informe-sintetico"),
    herramientas: Object.keys(HERRAMIENTAS),
    limites: { solicitudesModelo: scope.maxIterations, intentosHerramienta: scope.maxIterations,
      tiempoSesionMs: TIEMPO_SESION, tiempoBrokerMs: TIEMPO_BROKER },
  };
}

function limpiador(entorno) {
  const claves = [entorno.OPENAI_API_KEY, entorno.FOUNDRY_API_KEY, entorno.OPENSANDBOX_API_KEY]
    .map((clave) => clave?.trim()).filter(Boolean);
  return (valor, parcial = false) => {
    let texto = textoVisible(valor);
    for (const clave of claves) {
      texto = texto.replaceAll(clave, "[credencial omitida]");
      if (parcial) {
        for (let n = Math.min(texto.length, clave.length - 1); n > 0; n--) {
          if (!texto.endsWith(clave.slice(0, n))) continue;
          texto = texto.slice(0, -n);
          break;
        }
      }
    }
    return texto.replace(/\bsk-[a-zA-Z0-9_-]{8,}/g, "[credencial omitida]");
  };
}

function mensajeUsuario(texto, ocultar) {
  const limpio = typeof texto === "string" ? ocultar(texto).trim() : "";
  if (!limpio || limpio.length > 2000) throw new Error("Escribe un mensaje de entre 1 y 2000 caracteres.");
  return { id: randomUUID(), mensaje: { role: "user", content: limpio, timestamp: Date.now() } };
}

export async function iniciarSesionAgente({ proyecto, objetivo, alCambiar = () => {}, streamFn,
  broker = brokerMock, leerInventario = consultarInventario, entornoLlm = process.env, fetchOpenAI, timeoutMs = TIEMPO_SESION }) {
  const ocultar = limpiador(entornoLlm);
  const usuario = mensajeUsuario(objetivo, ocultar);
  const alcance = await prepararAlcance(proyecto);
  const objetivos = await cargarObjetivosMock(alcance.snapshot.scope);
  const modelo = await configurarModelo(proyecto.config, entornoLlm, fetchOpenAI, streamFn);
  const id = `agente-${randomUUID()}`;
  const dir = join(proyecto.raiz, "agentes", id);
  await mkdir(join(proyecto.raiz, "agentes"), { recursive: true, mode: 0o700 });
  await mkdir(dir, { mode: 0o700 });

  const estado = {
    esquema: ESQUEMA, id, parentId: null, goal: usuario.mensaje.content, status: "created", iteration: 0, toolAttempts: 0,
    adapterId: "mock", scopeId: alcance.scopeId, scopeRevision: alcance.revision, snapshot: alcance.snapshot,
    provider: modelo.provider, modelId: modelo.modelo.id,
    ...(modelo.provider === "azure-foundry" && { modelHost: new URL(modelo.modelo.baseUrl).host }),
    lastEvent: null, uso: new Date().toISOString(),
  };
  const item = vistaSesion(dir, estado);
  await lanzarTurnos({ proyecto, item, usuario, alCambiar, broker, leerInventario, entornoLlm, fetchOpenAI, ocultar, timeoutMs,
    async preparar() {
      await guardarJson(join(dir, "sesion.json"), estado);
      return { estado, alcance, objetivos, modelo };
    },
  });
  return item;
}

export async function enviarMensajeAgente({ proyecto, item, texto, alCambiar = () => {}, streamFn,
  broker = brokerMock, leerInventario = consultarInventario, entornoLlm = process.env, resolverEntornoLlm, fetchOpenAI, timeoutMs = TIEMPO_SESION }) {
  if (item.encolar) {
    try {
      return await item.encolar(texto);
    } catch (error) {
      if (error.code !== "turn_closed") throw error;
    }
  }
  if (item.soloConsulta) throw new Error("Esta sesión está disponible para consulta. Usa /agente para una nueva sesión.");
  if (item.trabajo) {
    await item.trabajo;
    return enviarMensajeAgente({ proyecto, item, texto, alCambiar, streamFn, broker, leerInventario, entornoLlm, resolverEntornoLlm, fetchOpenAI, timeoutMs });
  }
  if (resolverEntornoLlm) {
    const entornoResuelto = await resolverEntornoLlm();
    return enviarMensajeAgente({ proyecto, item, texto, alCambiar, streamFn, broker, leerInventario,
      entornoLlm: entornoResuelto, fetchOpenAI, timeoutMs });
  }
  const ocultar = limpiador(entornoLlm);
  const usuario = mensajeUsuario(texto, ocultar);
  return lanzarTurnos({ proyecto, item, usuario, alCambiar, broker, leerInventario, entornoLlm, fetchOpenAI, ocultar, timeoutMs,
    async preparar() {
      const estado = await leerJson(join(item.dir, "sesion.json"));
      if (ACTIVO.has(estado.status) || SOLO_CONSULTA.has(estado.reason)) throw new FinSesion("interrupted");
      let alcance;
      try {
        alcance = await prepararAlcance(proyecto, estado);
      } catch (error) {
        if (error.code === "scope_changed") {
          estado.status = "error";
          estado.reason = error.code;
          estado.lastEvent = { type: "end", reason: error.code };
          await guardarJson(join(item.dir, "sesion.json"), estado);
          Object.assign(item, vistaSesion(item.dir, estado, await leerHistorial(item.dir)));
        }
        throw error;
      }
      const objetivos = await cargarObjetivosMock(alcance.snapshot.scope);
      const config = { llm: { proveedor: estado.provider, openaiModelId: estado.modelId },
        ...(estado.provider === "azure-foundry" && { foundry: { host: estado.modelHost, deployment: estado.modelId } }) };
      const modelo = await configurarModelo(config, entornoLlm, fetchOpenAI, streamFn);
      estado.modelId ??= modelo.modelo.id;
      return { estado, alcance, objetivos, modelo };
    },
  });
}

function prepararBuzon(ocultar) {
  const cola = [];
  const diferidos = [];
  let sellado = false;
  let listo = Promise.withResolvers();
  let ultimo = Promise.resolve();
  let cerrado = false;
  const serie = (operacion) => {
    const siguiente = ultimo.then(operacion);
    ultimo = siguiente.catch(() => {});
    return siguiente;
  };
  listo.promise.catch(() => {});
  return {
    abrir: (anotar) => listo.resolve(anotar),
    fallar: (error) => listo.reject(error),
    encolar: (texto) => {
      const usuario = mensajeUsuario(texto, ocultar);
      return serie(async () => {
        if (cerrado) throw Object.assign(new Error("El turno ya cerró."), { code: "turn_closed" });
        const anotar = await listo.promise;
        await anotar([eventoUsuario(usuario)]);
        (sellado ? diferidos : cola).push(usuario);
        return usuario.id;
      });
    },
    entregar: (cierre = false) => serie(() => {
      const mensajes = cola.splice(0);
      if (cierre && !mensajes.length) sellado = true;
      return mensajes;
    }),
    cerrar: (continuar, finalizar) => serie(async () => {
      sellado = true;
      const pendientes = cola.splice(0);
      const siguientes = diferidos.splice(0);
      await finalizar(continuar ? pendientes : [...pendientes, ...siguientes], continuar && siguientes.length > 0);
      if (continuar && siguientes.length) {
        listo = Promise.withResolvers();
        listo.promise.catch(() => {});
        sellado = false;
        return siguientes;
      }
      cerrado = true;
      return [];
    }),
  };
}

function eventoUsuario({ id, mensaje }) {
  return { type: "user", messageId: id, text: mensaje.content, fecha: new Date(mensaje.timestamp).toISOString() };
}

function lanzarTurnos({ proyecto, item, usuario, preparar, alCambiar, broker, leerInventario, entornoLlm, fetchOpenAI, ocultar, timeoutMs }) {
  const dir = item.dir;
  const buzon = prepararBuzon(ocultar);
  const inicio = Promise.withResolvers();
  const controlador = new AbortController();
  item.controlador = controlador;
  item.encolar = buzon.encolar;
  item.trabajo = conBloqueoProyecto(dir, async () => {
    const { estado, alcance, objetivos, modelo } = await preparar();
    let entradas = [usuario];
    let turnos = await leerHistorial(dir);
    let primerTurno = true;
    while (entradas.length) {
      const revalidar = !primerTurno;
      primerTurno = false;
      estado.status = "created";
      estado.admisionAbierta = true;
      estado.reason = undefined;
      estado.turnNumber = turnos.length + 1;
      estado.iteration = estado.toolAttempts = 0;
      estado.budget = { requests: alcance.snapshot.scope.maxIterations, tools: alcance.snapshot.scope.maxIterations, timeoutMs };
      estado.uso = new Date().toISOString();
      estado.consumo = undefined;
      const evidencias = new Map();
      const resultados = new Map();
      for (const turno of turnos) for (const evento of turno.eventos) {
        if (evento.type !== "tool_result") continue;
        const verificar = () => leerResultadoAuditado(proyecto.raiz, estado, objetivos, turno.id, evento);
        const evidencia = await verificar();
        if (!evidencia) continue;
        resultados.set(evento.auditId, evidencia);
        if (evidencia.prueba && evento.tool !== "registrar_hallazgo") {
          evidencias.set(evidencia.prueba.id, { ...evidencia, verificar });
        }
      }
      const signal = AbortSignal.any([controlador.signal, AbortSignal.timeout(timeoutMs)]);
      entradas = await ejecutarSesion({ proyecto, dir, estado, alcance: { ...alcance, objetivos, evidencias },
        modelo, signal, broker, leerInventario, fetchOpenAI, entornoLlm, ocultar, buzon, entradas,
        previos: contextoHistorico(turnos, ocultar, resultados, modelo.modelo), inicio, revalidar,
        publicar(eventos, parciales) {
          const actual = estado.turnId ? [...turnos, { id: estado.turnId, eventos }] : turnos;
          Object.assign(item, vistaSesion(dir, estado, actual, parciales));
          alCambiar(item);
        },
        alCerrar: () => { item.encolar = undefined; },
      });
      turnos = await leerHistorial(dir);
    }
  }).catch((error) => {
    buzon.fallar(error);
    inicio.reject(error);
    if (ACTIVO.has(item.estado)) {
      item.estado = "error";
      item.soloConsulta = true;
      item.actividad = MOTIVOS.session_error;
    }
  }).finally(() => {
    item.trabajo = undefined;
    item.controlador = undefined;
    item.encolar = undefined;
    alCambiar(item);
  });
  return inicio.promise;
}

async function ejecutarSesion({ proyecto, dir, estado, alcance, modelo, signal, broker, leerInventario, publicar, fetchOpenAI, entornoLlm,
  ocultar, buzon, entradas, previos, inicio, alCerrar, revalidar }) {
  const eventos = [];
  const rutaEstado = join(dir, "sesion.json");
  const limite = alcance.snapshot.scope.maxIterations;
  const parciales = new Map();
  const pendientes = new Map(entradas.map((usuario) => [usuario.id, usuario]));
  const idsUsuario = new WeakMap(entradas.map(({ id, mensaje }) => [mensaje, id]));
  let rutaTurno;
  let idRespuesta;
  let ultimoTexto = "";
  let escritura = Promise.resolve();
  const llamadas = new Map();
  const resultadosPi = new WeakMap();
  const idsHerramienta = new Set();
  const seguimiento = estado.provider === "openai" ? seguirOpenAI(fetchOpenAI, entornoLlm, modelo.modelo) : null;
  const metadatosModelo = () => seguimiento ? { modelId: estado.modelId, consumo: seguimiento.resumen() } : {};

  function anotar(evento) {
    return guardarEventos([evento]);
  }

  function guardarEventos(nuevos) {
    if (!nuevos.length) return Promise.resolve();
    const operacion = escritura.then(async () => {
      for (const evento of nuevos) {
        const entrada = { fecha: new Date().toISOString(), ...evento };
        eventos.push(entrada);
        if (!["user", "user_state"].includes(entrada.type)) {
          estado.lastEvent = { type: entrada.type, tool: entrada.tool, iteration: entrada.iteration, reason: entrada.reason };
        }
      }
      if (rutaTurno) await guardarJson(join(rutaTurno, "eventos.json"), eventos);
      await guardarJson(rutaEstado, estado);
      publicar(eventos, [...parciales.values()]);
    });
    escritura = operacion;
    return operacion;
  }

  async function recogerMensajes(cierre) {
    const usuarios = await buzon.entregar(cierre);
    for (const usuario of usuarios) {
      pendientes.set(usuario.id, usuario);
      idsUsuario.set(usuario.mensaje, usuario.id);
    }
    return usuarios.map(({ mensaje }) => mensaje);
  }

  async function vigente() {
    const actual = await leerControlWifi(proyecto).catch(() => null);
    return actual?.revision === alcance.revision && hashAlcance(actual) === alcance.scopeId;
  }

  function obtenerLlamada(toolCallId, nombre) {
    const llamada = llamadas.get(toolCallId);
    if (!llamada || llamada.nombre !== nombre) throw new FinSesion("session_error");
    return llamada;
  }

  async function auditarHerramienta(llamada, operacion, signalOperacion) {
    try {
      await auditar(proyecto.raiz, {
        origen: "agente", sesion: estado.id, padre: estado.turnId, scopeId: estado.scopeId,
        operacion: llamada.tool, intento: llamada.numero, motor: llamada.tool === "consultar_adaptadores" ? "inventario-local" : "mock",
        llamadaId: llamada.id,
        parametrosNormalizados: llamada.parametros,
      }, operacion, signalOperacion, ({ id, estado, error, resultado }) => {
        llamada.auditId = id;
        const denegada = error instanceof DecisionDenegada;
        const autorizada = llamada.autorizada && !denegada;
        const motivo = estado === "cancelado" ? "cancelled"
          : denegada ? error.code : error ? "broker_error" : "authorized";
        llamada.auditoria = {
          autorizacion: { decision: autorizada ? "ALLOWED" : "DENIED", motivo },
          referenciasEvidencia: [
            ...(autorizada && llamada.evidenciaEntrada ? [llamada.evidenciaEntrada.referencia] : []),
            ...(resultado?.evidencia ? [resultado.evidencia] : []),
          ],
        };
        return { ...(error ? { motivo: MOTIVOS[motivo] ?? motivo } : {}),
          consultaInventario: resultado?.consultaInventario, ...llamada.auditoria };
      });
    } catch (error) {
      if (signal.aborted) llamada.result = { ok: false, code: "cancelled" };
      else if (error instanceof DecisionDenegada) llamada.result = { ok: false, code: error.code };
      else llamada.result = { ok: false, code: "broker_error" };
    }
  }

  async function consultarHardware(llamada, onUpdate) {
    onUpdate?.({ content: [], details: {} });
    const inventario = depurarInventario(await leerInventario(signal));
    signal.throwIfAborted();
    try {
      return await conBloqueoProyecto(proyecto.raiz, async () => {
        if (!await vigente()) throw new DecisionDenegada("scope_changed");
        signal.throwIfAborted();
        llamada.result = inventario;
        llamada.consultaInventario = {
          ok: true, origen: inventario.origen, adaptadorSesion: "mock", inventarioEstado: inventario.inventarioEstado,
        };
        return { consultaInventario: llamada.consultaInventario };
      });
    } catch (error) {
      if (error.code === "LOCK_BUSY") throw new DecisionDenegada("scope_busy");
      throw error;
    }
  }

  async function ejecutarHerramienta(toolCallId, nombre, onUpdate) {
    const llamada = obtenerLlamada(toolCallId, nombre);
    if (!llamada.decision.ok || llamada.despachada) throw new FinSesion("session_error");
    llamada.despachada = true;
    await auditarHerramienta(llamada, async (id) => {
      signal.throwIfAborted();
      if (!await vigente()) throw new DecisionDenegada("scope_changed");
      const params = nombre === "registrar_hallazgo" ? {
        ...llamada.decision.params,
        categoria: ocultar(llamada.decision.params.categoria),
        detalle: ocultar(llamada.decision.params.detalle),
      } : llamada.decision.params;
      llamada.autorizada = true;
      if (nombre === "consultar_adaptadores") return consultarHardware(llamada, onUpdate);
      let evidencia = params.evidenceId && alcance.evidencias.get(params.evidenceId);
      if (evidencia?.verificar) {
        evidencia = await evidencia.verificar();
        if (!evidencia?.bssids.includes(params.bssid)) throw new DecisionDenegada("evidence_denied");
      }
      llamada.detalle = params;

      llamada.evidenciaEntrada = evidencia;
      onUpdate?.({ content: [], details: {} });
      const respuesta = await broker({
        sessionId: estado.id, scopeId: estado.scopeId, snapshot: alcance.snapshot, action: nombre, params,
        evidence: evidencia?.prueba ?? null,
      }, signal);
      signal.throwIfAborted();
      const resultado = JSON.parse(ocultar(JSON.stringify(respuesta)));
      if (!resultado.ok) {
        if (DENEGACIONES_BROKER.has(resultado.code)) throw new DecisionDenegada(resultado.code);
        throw new Error("No se completó la operación del broker mock.");
      }
      const bssids = nombre === "observar_entorno"
        ? resultado.observaciones.map(({ bssid }) => bssid) : [resultado.bssid];
      if (resultado.origen !== "mock" || bssids.some((bssid) => !alcance.objetivos.has(bssid))
          || (nombre !== "observar_entorno" && resultado.bssid !== params.bssid)) {
        throw new DecisionDenegada("target_denied");
      }
      try {
        return await conBloqueoProyecto(proyecto.raiz, async () => {
          if (!await vigente()) throw new DecisionDenegada("scope_changed");
          const registro = { id, sessionId: estado.id, scopeId: estado.scopeId, bssids, action: nombre, resultado };
          const carpeta = join(rutaTurno, nombre === "registrar_hallazgo" ? "hallazgos" : "evidencias");
          await mkdir(carpeta, { recursive: true, mode: 0o700 });
          signal.throwIfAborted();
          const archivo = join(carpeta, `${id}.json`);
          await guardarJson(archivo, registro);
          const sha256 = createHash("sha256").update(await readFile(archivo)).digest("hex");
          const referencia = { id, referencia: archivo.slice(proyecto.raiz.length + 1), sha256, origen: "mock" };
          if (nombre === "registrar_hallazgo") llamada.result = { ...resultado, findingId: id };
          else {
            const prueba = { id, sessionId: estado.id, scopeId: estado.scopeId, bssids };
            alcance.evidencias.set(id, { bssids, prueba, referencia });
            llamada.result = { ...resultado, evidenceId: id };
          }
          return { evidencia: referencia };
        });
      } catch (error) {
        if (error.code === "LOCK_BUSY") throw new DecisionDenegada("scope_busy");
        throw error;
      }
    }, signal);
    return resultadoHerramienta(llamada.result);
  }

  function anotarResultado(llamada) {
    return anotar({ type: "tool_result", tool: llamada.tool, llamadaId: llamada.id,
      result: llamada.result.ok ? llamada.consultaInventario ?? llamada.result : llamada.result,
      parametros: llamada.detalle ?? llamada.parametros,
      auditId: llamada.auditId, ...llamada.auditoria });
  }

  async function emitir(evento) {
    if (evento.type === "tool_execution_start") {
      signal.throwIfAborted();
      const { toolCallId, toolName: nombre, args } = evento;
      if (llamadas.has(toolCallId)) throw new FinSesion("session_error");
      const tool = Object.hasOwn(HERRAMIENTAS, nombre) ? nombre : "herramienta_desconocida";
      const llamada = { id: randomUUID(), nombre, tool, numero: estado.toolAttempts + 1,
        parametros: parametrosAuditables(nombre, args) };
      if (llamada.numero > limite) {
        await auditarHerramienta(llamada, () => { throw new DecisionDenegada("tool_limit"); });
        await anotarResultado(llamada);
        throw new FinSesion("tool_limit");
      }
      estado.toolAttempts = llamada.numero;
      llamada.decision = idsHerramienta.has(toolCallId) ? { ok: false, code: "duplicate_tool_call" }
        : authorize({ name: nombre, args }, alcance, {
          status: estado.status, intento: llamada.numero, vigente: await vigente(),
        });
      idsHerramienta.add(toolCallId);
      llamadas.set(toolCallId, llamada);
      await anotar({ type: "tool_call", tool, attempt: llamada.numero, llamadaId: llamada.id, parametros: llamada.parametros });
    } else if (evento.type === "tool_execution_update") {
      const llamada = obtenerLlamada(evento.toolCallId, evento.toolName);
      await anotar({ type: "tool_progress", tool: llamada.tool, llamadaId: llamada.id });
    } else if (evento.type === "tool_execution_end") {
      const llamada = obtenerLlamada(evento.toolCallId, evento.toolName);
      if (!llamada.result) {
        const code = llamada.decision.code ?? "invalid_arguments";
        await auditarHerramienta(llamada, () => { throw new DecisionDenegada(code); }, signal);
      }
      await anotarResultado(llamada);
      if (llamada.result.code === "scope_changed") throw new FinSesion("scope_changed");
    } else if (evento.type === "message_end" && evento.message.role === "toolResult") {
      const { toolCallId, toolName } = evento.message;
      const llamada = obtenerLlamada(toolCallId, toolName);
      resultadosPi.set(evento.message, resultadoHerramienta(llamada.result));
      llamadas.delete(toolCallId);
    } else if (evento.message?.role === "assistant" && ["message_start", "message_update", "message_end"].includes(evento.type)) {
      const fin = evento.type === "message_end";
      idRespuesta ??= randomUUID();
      const partes = evento.message.content.filter(({ type }) => type === "text").map(({ text }) => text);
      const texto = ocultar(partes.join("\n\n"), !fin);
      const resumen = ocultar(seguimiento?.resumenOficial() ?? "", !fin);
      const idResumen = idRespuesta + "/summary";
      if (fin) {
        const nuevos = [];
        if (resumen) nuevos.push({ type: "summary", messageId: idResumen, text: resumen });
        if (texto) nuevos.push({ type: "response", messageId: idRespuesta, text: texto });
        parciales.clear();
        idRespuesta = undefined;
        ultimoTexto = "";
        await guardarEventos(nuevos);
        publicar(eventos, []);
      } else if (ultimoTexto !== JSON.stringify([texto, resumen])) {
        ultimoTexto = JSON.stringify([texto, resumen]);
        parciales.set(idResumen, { id: idResumen, text: resumen, resumen: true });
        parciales.set(idRespuesta, { id: idRespuesta, text: texto });
        publicar(eventos, [...parciales.values()]);
      }
    } else if (evento.type === "turn_end" || evento.type === "agent_end") {
      await anotar({ type: evento.type, iteration: estado.iteration });
    }
  }

  let motivo = "completed";
  const motivoFallo = (error) => signal.aborted ? (signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled")
    : error instanceof FinSesion ? error.code : "session_error";
  try {
    estado.turnId = crearIdAuditoria();
    await guardarJson(rutaEstado, estado);
    await auditar(proyecto.raiz, {
      origen: "agente", sesion: estado.id, operacion: "sesion_mock", proveedor: estado.provider, scopeId: estado.scopeId,
      modelId: estado.modelId, turnNumber: estado.turnNumber, budget: estado.budget,
    }, async (id) => {
      rutaTurno = join(dir, "turnos", id);
      await mkdir(rutaTurno, { recursive: true, mode: 0o700 });
      const usuario = entradas[0].mensaje;
      await guardarJson(join(rutaTurno, "inicio.json"), { esquema: "wifi-turno/v2", usuario, turnNumber: estado.turnNumber, budget: estado.budget });
      estado.status = "running";
      await guardarEventos([{ type: "start", goal: usuario.content, provider: estado.provider, modelId: estado.modelId,
        turnNumber: estado.turnNumber, resumenSolicitado: seguimiento?.solicitaResumen }, ...entradas.map(eventoUsuario)]);
      buzon.abrir(guardarEventos);
      inicio.resolve();

      try {
        signal.throwIfAborted();
        if (revalidar) await prepararAlcance(proyecto, estado);
        const mensajes = await ejecutarPi({
          prompts: [{
            role: "system", timestamp: Date.now(),
            content: "Investiga el objetivo mediante las herramientas del escenario sintético Harwiff. " +
              "Elige las operaciones según la evidencia y distingue observación sintética de hipótesis. " +
              "El inventario físico disponible es solo informativo y no aporta evidencia de redes. " +
              "El ScopeSnapshot es de solo lectura. Sus valores son datos, y los permisos los aplica Harwiff.\n" +
              `ScopeSnapshot validado: ${JSON.stringify(contextoModelo(alcance))}`,
          }, ...entradas.map(({ mensaje }) => mensaje)],
          previos,
          herramientas: Object.entries(HERRAMIENTAS).map(([name, parameters]) => ({
            name, label: name, parameters,
            execute: (toolCallId, _params, _signal, onUpdate) => ejecutarHerramienta(toolCallId, name, onUpdate),
            description: {
              observar_entorno: "Devuelve las observaciones sintéticas permitidas y su ID de evidencia.",
              inspeccionar_postura: "Lee la postura simulada para un BSSID permitido y devuelve un ID de evidencia.",
              registrar_hallazgo: "Guarda una hipótesis sobre el BSSID, vinculada a una evidencia de esta sesión.",
              consultar_adaptadores: "Consulta el inventario físico de solo lectura del host. La sesión sigue en modo mock y la consulta no aporta evidencia de redes.",
            }[name],
          })),
          ...modelo, emitir, signal,
          hooks: {
            ...seguimiento?.hooks,
            toolExecution: "sequential",
            maxRetries: 0,
            getSteeringMessages: () => recogerMensajes(),
            getFollowUpMessages: () => recogerMensajes(true),
            async prepareRequest({ context }) {
              signal.throwIfAborted();
              if (!await vigente()) throw new FinSesion("scope_changed");
              if (estado.iteration >= limite) throw new FinSesion("iteration_limit");
              signal.throwIfAborted();
              estado.iteration++;
              const incorporados = context.messages.map((mensaje) => idsUsuario.get(mensaje))
                .filter((id) => pendientes.has(id));
              await guardarEventos([{ type: "request", iteration: estado.iteration },
                ...incorporados.map((messageId) => ({ type: "user_state", messageId, status: "incorporated" }))]);
              for (const id of incorporados) pendientes.delete(id);
              seguimiento?.nuevaSolicitud();
            },
            async beforeToolCall({ toolCall }) {
              const { decision } = obtenerLlamada(toolCall.id, toolCall.name);
              if (!decision.ok) return { block: true, reason: JSON.stringify(decision) };
            },
            transformContext: (mensajes) => mensajes.map((mensaje) => {
              const resultado = resultadosPi.get(mensaje);
              return resultado ? { ...mensaje, ...resultado } : mensaje;
            }),
            async finishTurn({ message }) {
              signal.throwIfAborted();
              if (!await vigente()) throw new FinSesion("scope_changed");
              if (message.stopReason === "error" || message.stopReason === "aborted") {
                throw new FinSesion(seguimiento?.errorActual() ?? "provider_error");
              }
              if (estado.iteration >= limite && message.stopReason !== "stop") {
                motivo = "iteration_limit";
                return { action: "end" };
              }
            },
          },
        });
        if (motivo === "completed" && mensajes.findLast((m) => m.role === "assistant")?.stopReason !== "stop") {
          throw new FinSesion("provider_error");
        }
      } catch (error) {
        if (!(error instanceof FinSesion) || !["tool_limit", "iteration_limit"].includes(error.code)) throw error;
        motivo = error.code;
      }
      signal.throwIfAborted();
      return { evidencia: { referencia: `agentes/${estado.id}/turnos/${id}/resultado.json` } };
    }, undefined, ({ error }) => ({
      ...(signal.aborted && error ? { estado: "cancelado" } : {}),
      reason: error ? motivoFallo(error) : motivo,
      iteration: estado.iteration, toolAttempts: estado.toolAttempts,
      ...metadatosModelo(),
    }), estado.turnId);
    estado.status = "completed";
  } catch (error) {
    estado.status = signal.aborted ? "cancelled" : "error";
    motivo = motivoFallo(error);
  }
  if (!rutaTurno) throw new FinSesion(motivo);
  estado.reason = motivo;
  if (seguimiento) {
    estado.consumo = seguimiento.resumen();
    await anotar({ type: "usage", consumo: estado.consumo });
  }
  const siguientes = await buzon.cerrar(motivo === "completed" && !signal.aborted, async (sinTurno, admisionAbierta) => {
    for (const usuario of sinTurno) pendientes.set(usuario.id, usuario);
    const cierre = [...pendientes.keys()].map((messageId) => ({ type: "user_state", messageId, status: "not_sent" }));
    await guardarJson(join(rutaTurno, "resultado.json"), resultadoTurno(eventos, estado.status, motivo, {
      iteration: estado.iteration, toolAttempts: estado.toolAttempts, turnNumber: estado.turnNumber,
      budget: estado.budget, modelId: estado.modelId, ...metadatosModelo(),
    }));
    estado.admisionAbierta = admisionAbierta;
    parciales.clear();
    await guardarEventos([...cierre, { type: "end", reason: motivo }]);
  });
  if (!siguientes.length) alCerrar();
  return siguientes;
}

function resultadoHerramienta(resultado) {
  return { content: [{ type: "text", text: JSON.stringify(resultado) }], details: {}, isError: !resultado.ok };
}
