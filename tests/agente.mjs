import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as esperar } from "node:timers/promises";

import { guardarJson, respuestaSimulada } from "../bucle.mjs";
import { entorno } from "../entorno.mjs";
import { authorize, cargarObjetivosMock } from "../policy.mjs";
import { buildScopeSnapshot, guardarAlcance, hashAlcance, leerAuditoria, leerControlWifi, usarAdaptador } from "../proyecto.mjs";
import { cargarSesionAutonoma, iniciarSesionAgente } from "../sesion-agente.mjs";

const raiz = await mkdtemp(join(tmpdir(), "harwiff-agente-"));
const proyecto = { raiz, config: { cliente: "demo" } };
const permitido = "AA:BB:CC:11:22:33";
const ajeno = "AA:BB:CC:11:22:44";
const scope = { allowedBssids: [], allowedSsids: ["LAB_TEST_AP"], allowedChannels: [6], maxIterations: 8 };
const alternativa = { ...scope, allowedSsids: ["LAB_FUERA"], allowedChannels: [11] };
const llamada = (name, args = {}) => ({ type: "toolCall", id: randomUUID(), name, arguments: args });
const fin = { type: "text", text: "La sesión de prueba concluyó." };
const leer = async (ruta) => JSON.parse(await readFile(ruta, "utf8"));
const iniciar = (opciones) => iniciarSesionAgente({ proyecto, objetivo: "Verificar el fixture sintético",
  entornoLlm: {}, ...opciones });
const ejecutarBroker = (entrada, signal) => entorno("broker-mock", entrada, { signal });
const estado = (item) => leer(join(item.dir, "sesion.json"));

async function finalizar(item) {
  await item.trabajo;
  const datos = await estado(item);
  const turno = join(item.dir, "turnos", datos.turnId);
  const rutaEventos = join(turno, "eventos.json");
  const eventos = await leer(rutaEventos);
  const resultados = eventos.filter((evento) => evento.type === "tool_result");
  return { datos, turno, eventos, resultados };
}

function guion(...pasos) {
  let index = 0;
  return (modelo, contexto) => {
    const paso = pasos[index++] ?? [fin];
    return respuestaSimulada(modelo, typeof paso === "function" ? paso(contexto) : paso);
  };
}

function resultadoDe(contexto, nombre) {
  const mensaje = contexto.messages.findLast((item) => item.role === "toolResult" && item.toolName === nombre);
  return JSON.parse(mensaje.content[0].text);
}

try {
  const noInvocar = () => { throw new Error("El modelo no debe ser invocado"); };
  await assert.rejects(iniciar({ streamFn: noInvocar }), /Selecciona un adaptador/);
  const fisico = { ...proyecto, config: { ...proyecto.config, adaptador: "a".repeat(20) } };
  await assert.rejects(iniciar({ proyecto: fisico, streamFn: noInvocar }), /Selecciona el adaptador mock/);
  assert.deepEqual(await readdir(raiz), []);

  await guardarAlcance(proyecto, scope);
  await usarAdaptador(proyecto, "mock");
  const revision = (await leerControlWifi(proyecto)).revision;
  await guardarAlcance(proyecto, { ...scope, allowedSsids: ["LAB_TEST_AP", "LAB_TEST_AP"] });
  assert.equal((await leerControlWifi(proyecto)).revision, revision);
  const snapshot = await buildScopeSnapshot(proyecto);
  assert.equal(snapshot.adapter.id, "mock");
  assert.ok(Object.isFrozen(snapshot.scope.allowedSsids));
  const scopeId = hashAlcance(snapshot);

  const inicial = { sessionId: `agente-${randomUUID()}`, scopeId, snapshot, action: "observar_entorno",
    params: {}, evidence: null };
  const observacion = await ejecutarBroker(inicial);
  assert.deepEqual(observacion.observaciones.map(({ bssid }) => bssid), [permitido]);
  assert.deepEqual(await ejecutarBroker({ ...inicial, sessionId: "../../externo" }), { ok: false, code: "invalid_request" });
  assert.deepEqual(await ejecutarBroker({ ...inicial, scopeId: "a".repeat(64) }), { ok: false, code: "invalid_scope" });
  assert.deepEqual(await ejecutarBroker({ ...inicial, action: "inspeccionar_postura", params: { bssid: ajeno } }),
    { ok: false, code: "target_denied" });
  const distintosCanales = { ...snapshot, scope: { ...scope, allowedChannels: [1] } };
  assert.deepEqual((await ejecutarBroker({ ...inicial, snapshot: distintosCanales,
    scopeId: hashAlcance(distintosCanales) })).observaciones, []);
  const evidenceId = `${Date.now()}-${randomUUID()}`;
  const argsHallazgo = { bssid: permitido, categoria: "postura", detalle: "Observación del fixture", evidenceId };
  assert.deepEqual(await ejecutarBroker({ ...inicial, action: "registrar_hallazgo", params: argsHallazgo,
    evidence: { id: evidenceId, sessionId: `agente-${randomUUID()}`, scopeId, bssids: [permitido] } }),
  { ok: false, code: "evidence_denied" });

  const contexto = { snapshot, objetivos: await cargarObjetivosMock(scope), evidencias: new Map() };
  const autorizar = (name, args) => authorize({ name, args }, contexto, { status: "running", intento: 1, vigente: true });
  assert.deepEqual(autorizar("inspeccionar_postura", { bssid: permitido.toLowerCase() }), { ok: true, params: { bssid: permitido } });
  assert.equal(autorizar("inspeccionar_postura", { bssid: ajeno }).code, "target_denied");
  assert.equal(autorizar("registrar_hallazgo", argsHallazgo).code, "evidence_denied");
  assert.equal(autorizar("observar_entorno", { adapterId: "wlan1" }).code, "invalid_arguments");

  const consultas = [];
  const broker = (entrada, signal) => {
    consultas.push(entrada.action);
    return ejecutarBroker(entrada, signal);
  };
  const conDenegacion = await iniciar({ broker, streamFn: guion(
    [llamada("inspeccionar_postura", { bssid: ajeno }), llamada("herramienta_inexistente"),
      llamada("observar_entorno", { dato: "dato-privado-fixture" })],
    (ctx) => {
      assert.equal(resultadoDe(ctx, "inspeccionar_postura").code, "target_denied");
      assert.equal(resultadoDe(ctx, "herramienta_inexistente").code, "unknown_tool");
      assert.equal(resultadoDe(ctx, "observar_entorno").code, "invalid_arguments");
      return [llamada("observar_entorno")];
    },
    [llamada("inspeccionar_postura", { bssid: permitido })],
    (ctx) => [llamada("registrar_hallazgo", { ...argsHallazgo, evidenceId: resultadoDe(ctx, "inspeccionar_postura").evidenceId })],
    [{ type: "thinking", thinking: "contenido-privado-fixture" }, fin],
  ) });
  const primera = await finalizar(conDenegacion);
  assert.equal(primera.datos.status, "completed");
  assert.equal(primera.datos.parentId, null);
  assert.equal(primera.datos.adapterId, "mock");
  assert.equal(primera.datos.scopeId, scopeId);
  assert.equal(primera.datos.iteration, 5);
  assert.equal(primera.datos.toolAttempts, 6);
  assert.deepEqual(consultas, ["observar_entorno", "inspeccionar_postura", "registrar_hallazgo"]);
  assert.deepEqual(primera.resultados.slice(0, 3).map((evento) => evento.result.code),
    ["target_denied", "unknown_tool", "invalid_arguments"]);
  for (const denegada of primera.resultados.slice(0, 3)) {
    assert.equal((await leerAuditoria(raiz, denegada.auditId)).estado, "bloqueado");
  }
  assert.equal((await readdir(join(primera.turno, "evidencias"))).length, 2);
  const hallazgo = await leer(join(primera.turno, "hallazgos", `${primera.resultados.at(-1).auditId}.json`));
  assert.equal(hallazgo.resultado.estado, "hipotesis");
  assert.equal(hallazgo.resultado.evidenceId, primera.resultados.at(-2).auditId);
  for (const archivo of ["eventos.json", "resultado.json"]) {
    assert.doesNotMatch(await readFile(join(primera.turno, archivo), "utf8"), /(?:dato|contenido)-privado-fixture/);
  }

  consultas.length = 0;
  const ordenAlternativo = await finalizar(await iniciar({ broker, streamFn: guion(
    [llamada("inspeccionar_postura", { bssid: permitido })],
    [llamada("observar_entorno")],
    [llamada("registrar_hallazgo", argsHallazgo)],
    [fin],
  ) }));
  assert.equal(ordenAlternativo.datos.status, "completed");
  assert.deepEqual(consultas, ["inspeccionar_postura", "observar_entorno"]);
  assert.equal(ordenAlternativo.resultados.at(-1).result.code, "evidence_denied");

  const claveFixture = "credencial-ficticia-del-proveedor";
  const foundry = await finalizar(await iniciar({
    entornoLlm: { FOUNDRY_HOST: "fixture.openai.azure.com", FOUNDRY_DEPLOYMENT: "fixture", FOUNDRY_API_KEY: claveFixture },
    streamFn(modelo, _contexto, opciones) {
      assert.equal(modelo.baseUrl, "https://fixture.openai.azure.com/openai/v1");
      assert.equal(opciones.apiKey, claveFixture);
      assert.equal(opciones.maxRetries, 0);
      return respuestaSimulada(modelo, [fin]);
    },
  }));
  assert.equal(foundry.datos.provider, "azure-foundry");
  assert.equal(foundry.datos.status, "completed");
  assert.ok(!JSON.stringify(foundry).includes(claveFixture));
  const demoConEntornoParcial = await finalizar(await iniciar({
    entornoLlm: { FOUNDRY_API_KEY: claveFixture }, streamFn: guion([fin]),
  }));
  assert.equal(demoConEntornoParcial.datos.provider, "demo");

  const limiteLote = await finalizar(await iniciar({ streamFn: guion(
    Array.from({ length: 14 }, () => llamada("herramienta_inexistente")),
  ) }));
  assert.equal(limiteLote.datos.status, "completed");
  assert.equal(limiteLote.datos.reason, "tool_limit");
  assert.equal(limiteLote.datos.iteration, 1);
  assert.equal(limiteLote.datos.toolAttempts, 8);
  assert.equal(limiteLote.resultados.at(-1).result.code, "tool_limit");

  let solicitudes = 0;
  const limiteModelo = await finalizar(await iniciar({ streamFn: (modelo) => {
    solicitudes++;
    return respuestaSimulada(modelo, [llamada("herramienta_inexistente")]);
  } }));
  assert.equal(solicitudes, 8);
  assert.equal(limiteModelo.datos.reason, "iteration_limit");
  assert.equal(limiteModelo.datos.toolAttempts, 8);

  const llego = Promise.withResolvers();
  const continuar = Promise.withResolvers();
  const revocada = await iniciar({ streamFn: guion([llamada("observar_entorno")]), broker: async (entrada, signal) => {
    llego.resolve();
    await continuar.promise;
    return ejecutarBroker(entrada, signal);
  } });
  await llego.promise;
  try {
    const activa = await cargarSesionAutonoma(revocada.dir, await estado(revocada));
    assert.equal(activa.estado, "running");
    await guardarAlcance(proyecto, alternativa);
    await guardarAlcance(proyecto, scope);
    assert.equal(hashAlcance(await buildScopeSnapshot(proyecto)), scopeId);
    assert.equal((await leerControlWifi(proyecto)).revision, revision + 2);
  } finally {
    continuar.resolve();
  }
  const descartada = await finalizar(revocada);
  assert.equal(descartada.datos.status, "error");
  assert.equal(descartada.datos.reason, "scope_changed");
  assert.equal(descartada.resultados[0].result.code, "scope_changed");
  assert.equal((await leerAuditoria(raiz, descartada.resultados[0].auditId)).estado, "bloqueado");
  await assert.rejects(readdir(join(descartada.turno, "evidencias")), { code: "ENOENT" });

  const operando = Promise.withResolvers();
  const cancelada = await iniciar({ streamFn: guion([llamada("observar_entorno")]), broker: async (_entrada, signal) => {
    operando.resolve();
    await esperar(30_000, undefined, { signal });
  } });
  await operando.promise;
  cancelada.controlador.abort();
  const cancelacion = await finalizar(cancelada);
  assert.equal(cancelacion.datos.status, "cancelled");
  assert.equal((await leerAuditoria(raiz, cancelacion.resultados[0].auditId)).estado, "cancelado");
  await assert.rejects(readdir(join(cancelacion.turno, "evidencias")), { code: "ENOENT" });

  const datosInterrumpidos = { ...primera.datos, status: "running", reason: null };
  await guardarJson(join(conDenegacion.dir, "sesion.json"), datosInterrumpidos);
  const recuperada = await cargarSesionAutonoma(conDenegacion.dir, datosInterrumpidos);
  assert.equal(recuperada.estado, "error");
  assert.equal((await estado(conDenegacion)).reason, "interrupted");
  assert.equal((await readdir(join(primera.turno, "evidencias"))).length, 2);
  console.log("Fase 2A · política, broker, secuencias Pi, presupuestos, revocación, cancelación y recuperación verificados.");
} finally {
  await rm(raiz, { recursive: true, force: true });
}
