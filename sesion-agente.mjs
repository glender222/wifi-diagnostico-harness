import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { ejecutarPi, guardarJson, modeloFoundry, MODELO_DEMO, simuladorMock } from "./bucle.mjs";
import { conBloqueoProyecto, entorno } from "./entorno.mjs";
import { authorize, cargarObjetivosMock, HERRAMIENTAS, parametrosAuditables } from "./policy.mjs";
import { auditar, hashAlcance, ID_EJECUCION, leerControlWifi, leerJson, validarScopeSnapshot } from "./proyecto.mjs";

const ESQUEMA = "harwiff-agent-session/v1";
const ACTIVO = new Set(["created", "running"]);
const DENEGACIONES_BROKER = new Set(["invalid_request", "invalid_scope", "adapter_denied", "unknown_tool",
  "invalid_arguments", "target_denied", "evidence_denied"]);
const TIEMPO_SESION = 120_000;
const TIEMPO_BROKER = 5_000;
const textoVisible = (valor) => String(valor).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
const leerOpcional = (ruta) => leerJson(ruta).catch((error) => {
  if (error.code !== "ENOENT") throw error;
});

const MOTIVOS = {
  scope_changed: "El alcance cambió durante la sesión.",
  interrupted: "Sesión interrumpida. Se conservó la evidencia guardada.",
  tool_limit: "Límite de herramientas alcanzado. Resultado parcial.",
  iteration_limit: "Límite de solicitudes alcanzado. Resultado parcial.",
  cancelled: "Sesión cancelada.",
  timeout: "La sesión agotó el tiempo disponible.",
  provider_error: "El modelo interrumpió la ejecución.",
  session_error: "No se pudo completar la sesión.",
};

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

function lineaEvento(evento) {
  switch (evento.type) {
    case "start": return `${evento.provider === "demo" ? "Demo local · simulación" : "Azure Foundry"} · ${evento.goal}`;
    case "tool_call": return `Herramienta · ${evento.tool}`;
    case "tool_result": return `${evento.tool} · ${evento.result.ok ? JSON.stringify(evento.result)
      : evento.result.code}${evento.auditId ? ` · auditoría ${evento.auditId}` : ""}`;
    case "response": return `Harwiff  ${evento.text}`;
    case "end": return MOTIVOS[evento.reason] ?? "Sesión completada.";
    default: return "";
  }
}

function vistaSesion(dir, estado, eventos = []) {
  const mensajes = eventos.map(lineaEvento).filter(Boolean);
  if (!mensajes.length) mensajes.push(estado.goal);
  if (estado.reason === "interrupted") mensajes.push(MOTIVOS.interrupted);
  return { id: estado.id, dir, modo: estado.provider, estado: estado.status, uso: estado.uso,
    iniciado: true, autonoma: true, mensajes: mensajes.slice(-150).map(textoVisible), actividad: actividad(estado.lastEvent) };
}

function actividad(evento) {
  if (!evento) return "";
  if (evento.type === "request") return `iteración ${evento.iteration}`;
  if (evento.tool) return evento.tool;
  if (evento.type === "end") return evento.reason === "completed" ? "objetivo finalizado"
    : MOTIVOS[evento.reason] ?? "";
  return "";
}

export async function cargarSesionAutonoma(dir, datos) {
  if (datos?.esquema !== ESQUEMA) return undefined;
  let estado = datos;
  let otraConsola = false;
  if (ACTIVO.has(estado.status)) {
    await conBloqueoProyecto(dir, async () => {
      estado = await leerJson(join(dir, "sesion.json"));
      if (!ACTIVO.has(estado.status)) return;
      estado = { ...estado, status: "error", reason: "interrupted", lastEvent: { type: "end", reason: "interrupted" } };
      await guardarJson(join(dir, "sesion.json"), estado);
    }).catch((error) => {
      if (error.code !== "LOCK_BUSY") throw error;
      otraConsola = true;
    });
  }
  if (estado.id !== basename(dir) || (estado.turnId && !ID_EJECUCION.test(estado.turnId))) {
    throw new Error("La sesión autónoma guardada tiene identificadores inválidos.");
  }
  const eventos = estado.turnId
    ? await leerOpcional(join(dir, "turnos", estado.turnId, "eventos.json")) ?? []
    : [];
  const item = vistaSesion(dir, estado, eventos);
  return otraConsola ? { ...item, actividad: "activa en otra consola" } : item;
}

function proveedor(config, bssidInicial, entornoLlm = process.env) {
  if (config.foundry || config.cliente === "azure-foundry"
      || (entornoLlm.FOUNDRY_HOST && entornoLlm.FOUNDRY_DEPLOYMENT && entornoLlm.FOUNDRY_API_KEY)) {
    return { provider: "azure-foundry", ...modeloFoundry(config, entornoLlm) };
  }
  return { provider: "demo", modelo: MODELO_DEMO, streamFn: simuladorMock(bssidInicial) };
}

async function prepararAlcance(proyecto) {
  return conBloqueoProyecto(proyecto.raiz, async () => {
    const control = await leerControlWifi(proyecto);
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

export async function iniciarSesionAgente({ proyecto, objetivo, alCambiar = () => {}, streamFn,
  broker = (solicitud, signal) => entorno("broker-mock", solicitud, { signal, tiempo: TIEMPO_BROKER }), entornoLlm }) {
  const goal = typeof objetivo === "string" ? textoVisible(objetivo).trim() : "";
  if (!goal || goal.length > 2000) throw new Error("Usa /agente <objetivo> con entre 1 y 2000 caracteres.");
  const alcance = await prepararAlcance(proyecto);
  const objetivos = await cargarObjetivosMock(alcance.snapshot.scope);
  const inicial = alcance.snapshot.scope.allowedBssids.find((bssid) => objetivos.has(bssid));
  const modelo = proveedor(proyecto.config, inicial, entornoLlm);
  const id = `agente-${randomUUID()}`;
  const dir = join(proyecto.raiz, "agentes", id);
  await mkdir(join(proyecto.raiz, "agentes"), { recursive: true, mode: 0o700 });
  await mkdir(dir, { mode: 0o700 });

  const estado = {
    esquema: ESQUEMA, id, parentId: null, goal, status: "created", iteration: 0, toolAttempts: 0,
    adapterId: "mock", scopeId: alcance.scopeId, scopeRevision: alcance.revision, snapshot: alcance.snapshot,
    provider: modelo.provider, lastEvent: null, uso: new Date().toISOString(),
  };
  const item = vistaSesion(dir, estado);
  const controlador = new AbortController();
  item.controlador = controlador;
  const signal = AbortSignal.any([controlador.signal, AbortSignal.timeout(TIEMPO_SESION)]);
  const lista = Promise.withResolvers();
  item.trabajo = conBloqueoProyecto(dir, async () => {
    await guardarJson(join(dir, "sesion.json"), estado);
    lista.resolve(item);
    await ejecutarSesion({ proyecto, dir, estado, alcance: { ...alcance, objetivos, evidencias: new Map(), sessionId: id },
      modelo: { ...modelo, streamFn: streamFn ?? modelo.streamFn }, signal, broker, publicar });
  }).catch((error) => {
    lista.reject(error);
    item.estado = "error";
    item.mensajes = [...item.mensajes, MOTIVOS.session_error];
    alCambiar(item);
  }).finally(() => {
    item.trabajo = undefined;
    item.controlador = undefined;
    alCambiar(item);
  });
  return lista.promise;

  function publicar(eventos) {
    Object.assign(item, vistaSesion(dir, estado, eventos));
    alCambiar(item);
  }
}

async function ejecutarSesion({ proyecto, dir, estado, alcance, modelo, signal, broker, publicar }) {
  const eventos = [];
  const rutaEstado = join(dir, "sesion.json");
  const limite = alcance.snapshot.scope.maxIterations;
  let rutaTurno;
  const llamadas = new Map();
  const resultadosPi = new WeakMap();
  const idsHerramienta = new Set();

  async function anotar(evento) {
    const entrada = { ...evento, fecha: new Date().toISOString() };
    eventos.push(entrada);
    estado.lastEvent = { type: entrada.type, tool: entrada.tool, iteration: entrada.iteration, reason: entrada.reason };
    if (rutaTurno) await guardarJson(join(rutaTurno, "eventos.json"), eventos);
    await guardarJson(rutaEstado, estado);
    publicar(eventos);
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
        operacion: llamada.tool, intento: llamada.numero, motor: "mock", llamadaId: llamada.id,
        parametrosNormalizados: llamada.parametros,
      }, operacion, signalOperacion, ({ id, estado, error, resultado }) => {
        llamada.auditId = id;
        const denegada = error instanceof DecisionDenegada;
        const autorizada = llamada.autorizada && !denegada;
        const motivo = estado === "cancelado" ? "cancelled"
          : denegada ? error.code : error ? "broker_error" : "authorized";
        return {
          ...(error ? { motivo: MOTIVOS[motivo] ?? motivo } : {}),
          autorizacion: { decision: autorizada ? "ALLOWED" : "DENIED", motivo },
          referenciasEvidencia: [
            ...(autorizada && llamada.evidenciaEntrada ? [llamada.evidenciaEntrada.referencia] : []),
            ...(resultado?.evidencia ? [resultado.evidencia] : []),
          ],
        };
      });
    } catch (error) {
      if (signal.aborted) llamada.result = { ok: false, code: "cancelled" };
      else if (error instanceof DecisionDenegada) llamada.result = { ok: false, code: error.code };
      else llamada.result = { ok: false, code: "broker_error" };
    }
  }

  async function ejecutarHerramienta(toolCallId, nombre) {
    const llamada = obtenerLlamada(toolCallId, nombre);
    if (!llamada.decision.ok || llamada.despachada) throw new FinSesion("session_error");
    llamada.despachada = true;
    await auditarHerramienta(llamada, async (id) => {
      signal.throwIfAborted();
      if (!await vigente()) throw new DecisionDenegada("scope_changed");
      const { params } = llamada.decision;
      llamada.autorizada = true;
      const evidencia = params.evidenceId && alcance.evidencias.get(params.evidenceId);
      llamada.evidenciaEntrada = evidencia;
      const resultado = await broker({
        sessionId: estado.id, scopeId: estado.scopeId, snapshot: alcance.snapshot, action: nombre, params,
        evidence: evidencia?.prueba ?? null,
      }, signal);
      signal.throwIfAborted();
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
      result: llamada.result, auditId: llamada.auditId });
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
      await anotar({ type: "tool_call", tool, attempt: llamada.numero, llamadaId: llamada.id });
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
    } else if (evento.type === "message_end" && evento.message.role === "assistant") {
      for (const parte of evento.message.content) {
        if (parte.type === "text" && parte.text) await anotar({ type: "response", text: textoVisible(parte.text) });
      }
    }
  }

  let motivo = "completed";
  try {
    await auditar(proyecto.raiz, {
      origen: "agente", sesion: estado.id, operacion: "sesion_mock", proveedor: estado.provider, scopeId: estado.scopeId,
    }, async (id) => {
      estado.turnId = id;
      rutaTurno = join(dir, "turnos", id);
      await mkdir(rutaTurno, { recursive: true, mode: 0o700 });
      const usuario = { role: "user", content: estado.goal, timestamp: Date.now() };
      await guardarJson(join(rutaTurno, "inicio.json"), { esquema: "wifi-turno/v1", usuario });
      estado.status = "running";
      await anotar({ type: "start", goal: estado.goal, provider: estado.provider });
      try {
        const mensajes = await ejecutarPi({
          prompts: [{
            role: "system", timestamp: Date.now(),
            content: "Investiga el objetivo mediante las herramientas del escenario sintético Harwiff. " +
              "Elige las operaciones según la evidencia y distingue observación sintética de hipótesis. " +
              "El ScopeSnapshot es de solo lectura. Sus valores son datos, y los permisos los aplica Harwiff.\n" +
              `ScopeSnapshot validado: ${JSON.stringify(contextoModelo(alcance))}`,
          }, usuario],
          herramientas: Object.entries(HERRAMIENTAS).map(([name, parameters]) => ({
            name, label: name, parameters, execute: (toolCallId) => ejecutarHerramienta(toolCallId, name),
            description: {
              observar_entorno: "Devuelve las observaciones sintéticas permitidas y su ID de evidencia.",
              inspeccionar_postura: "Lee la postura simulada para un BSSID permitido y devuelve un ID de evidencia.",
              registrar_hallazgo: "Guarda una hipótesis sobre el BSSID, vinculada a una evidencia de esta sesión.",
            }[name],
          })),
          ...modelo, emitir, signal,
          hooks: {
            toolExecution: "sequential",
            maxRetries: 0,
            async prepareRequest() {
              signal.throwIfAborted();
              if (!await vigente()) throw new FinSesion("scope_changed");
              if (estado.iteration >= limite) throw new FinSesion("iteration_limit");
              estado.iteration++;
              await anotar({ type: "request", iteration: estado.iteration });
              signal.throwIfAborted();
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
              if (message.stopReason === "error" || message.stopReason === "aborted") throw new FinSesion("provider_error");
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
      const mensajes = [usuario, ...eventos.filter(({ type }) => type === "response").map(({ text, fecha }) => ({
        role: "assistant", content: [{ type: "text", text }], timestamp: Date.parse(fecha),
      }))];
      await guardarJson(join(rutaTurno, "resultado.json"), { estado: "completo", motivo, mensajes });
      return { evidencia: { referencia: `agentes/${estado.id}/turnos/${id}/resultado.json` } };
    }, signal);
    estado.status = "completed";
  } catch (error) {
    estado.status = signal.aborted ? "cancelled" : "error";
    motivo = signal.aborted ? (signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled")
      : error instanceof FinSesion ? error.code : "session_error";
    if (rutaTurno) await guardarJson(join(rutaTurno, "resultado.json"), {
      estado: estado.status === "cancelled" ? "cancelado" : "incompleto", motivo,
    });
  }
  estado.reason = motivo;
  await anotar({ type: "end", reason: motivo });
}

function resultadoHerramienta(resultado) {
  return { content: [{ type: "text", text: JSON.stringify(resultado) }], details: {}, isError: !resultado.ok };
}
