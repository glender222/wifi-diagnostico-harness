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
import { cargarSesionAutonoma, enviarMensajeAgente, iniciarSesionAgente } from "../sesion-agente.mjs";

const raiz = await mkdtemp(join(tmpdir(), "harwiff-agente-"));
const proyecto = { raiz, config: { cliente: "demo" } };
const permitido = "AA:BB:CC:11:22:33";
const ajeno = "AA:BB:CC:11:22:44";
const scope = { allowedBssids: [], allowedSsids: ["LAB_TEST_AP", "ssid-privado-no-mock"], allowedChannels: [6], maxIterations: 8 };
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
  await guardarAlcance(proyecto, { ...scope, allowedSsids: [...scope.allowedSsids, "LAB_TEST_AP"] });
  assert.equal((await leerControlWifi(proyecto)).revision, revision);
  await assert.rejects(iniciar(), /Configura el proveedor con \/connect/);
  await assert.rejects(readdir(join(raiz, "agentes")), { code: "ENOENT" });
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
  const argsHallazgo = { bssid: permitido, categoria: "categoria-privada-fixture",
    detalle: "detalle-privado-fixture", evidenceId };
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
  const llamadaFuera = llamada("inspeccionar_postura", { bssid: ajeno.toLowerCase() });
  const llamadaInvalida = {
    ...llamada("observar_entorno", { token: "token-privado-fixture", scope: { allowedBssids: [ajeno] } }),
    id: "id-privado-fixture",
  };
  const conDenegacion = await iniciar({ broker, streamFn: guion(
    (ctx) => {
      const sistema = ctx.messages.find((mensaje) => mensaje.role === "system").content;
      const prefijo = "ScopeSnapshot validado: ";
      const snapshotVisible = JSON.parse(sistema.split("\n").find((linea) => linea.startsWith(prefijo)).slice(prefijo.length));
      assert.deepEqual(snapshotVisible, {
        adaptador: { id: "mock", nombre: "mock", modo: "mock" },
        objetivosAutorizados: [{ bssid: permitido, ssid: "LAB_TEST_AP", canal: 6 }],
        canalesPermitidos: [6],
        capacidades: ["informe-sintetico"],
        herramientas: ["observar_entorno", "inspeccionar_postura", "registrar_hallazgo", "consultar_adaptadores"],
        limites: { solicitudesModelo: 8, intentosHerramienta: 8, tiempoSesionMs: 120_000, tiempoBrokerMs: 5_000 },
      });
      assert.ok(!sistema.includes(ajeno) && !sistema.includes("ssid-privado-no-mock") && !sistema.includes(snapshot.projectId));
      return [llamadaFuera, llamada("herramienta_inexistente"), llamadaInvalida];
    },
    (ctx) => {
      assert.equal(resultadoDe(ctx, "inspeccionar_postura").code, "target_denied");
      assert.equal(resultadoDe(ctx, "herramienta_inexistente").code, "unknown_tool");
      assert.equal(resultadoDe(ctx, "observar_entorno").code, "invalid_arguments");
      const ids = ctx.messages.filter((m) => m.role === "toolResult").map((m) => m.toolCallId);
      assert.equal(ids[0], llamadaFuera.id);
      assert.equal(ids.at(-1), llamadaInvalida.id);
      return [llamada("observar_entorno")];
    },
    [llamada("inspeccionar_postura", { bssid: permitido.toLowerCase() })],
    (ctx) => [llamada("registrar_hallazgo", { ...argsHallazgo, evidenceId: resultadoDe(ctx, "inspeccionar_postura").evidenceId })],
    [{ type: "thinking", thinking: "contenido-privado-fixture" }, fin],
  ) });
  const primera = await finalizar(conDenegacion);
  assert.equal(primera.datos.status, "completed");
  assert.equal(primera.datos.parentId, null);
  assert.equal(primera.datos.adapterId, "mock");
  assert.equal(primera.datos.scopeId, scopeId);
  assert.equal((await leerControlWifi(proyecto)).revision, revision);
  assert.equal(hashAlcance(await buildScopeSnapshot(proyecto)), scopeId);
  assert.equal(primera.datos.iteration, 5);
  assert.equal(primera.datos.toolAttempts, 6);
  assert.deepEqual(consultas, ["observar_entorno", "inspeccionar_postura", "registrar_hallazgo"]);
  assert.deepEqual(primera.resultados.slice(0, 3).map((evento) => evento.result.code),
    ["target_denied", "unknown_tool", "invalid_arguments"]);
  const auditorias = [];
  for (const evento of primera.resultados) {
    const solicitud = primera.eventos.find(({ type, llamadaId }) => type === "tool_call" && llamadaId === evento.llamadaId);
    assert.equal(solicitud.tool, evento.tool);
    const auditoria = await leerAuditoria(raiz, evento.auditId);
    assert.equal(auditoria.llamadaId, evento.llamadaId);
    auditorias.push(auditoria);
  }
  assert.equal(new Set(auditorias.map(({ llamadaId }) => llamadaId)).size, 6);
  for (const [indice, denegada] of auditorias.slice(0, 3).entries()) {
    assert.equal(denegada.estado, "bloqueado");
    assert.deepEqual(denegada.autorizacion, { decision: "DENIED", motivo: primera.resultados[indice].result.code });
    assert.deepEqual(denegada.referenciasEvidencia, []);
  }
  assert.deepEqual(auditorias[0].parametrosNormalizados, { bssid: ajeno });
  assert.deepEqual(auditorias[2].parametrosNormalizados, {});
  const [, posturaAuditada, hallazgoAuditado] = auditorias.slice(3);
  assert.deepEqual(posturaAuditada.parametrosNormalizados, { bssid: permitido });
  assert.deepEqual(hallazgoAuditado.autorizacion, { decision: "ALLOWED", motivo: "authorized" });
  assert.deepEqual(hallazgoAuditado.parametrosNormalizados, {
    bssid: permitido, evidenceId: posturaAuditada.id, categoria: { omitido: true }, detalle: { omitido: true },
  });
  assert.deepEqual(hallazgoAuditado.referenciasEvidencia, [posturaAuditada.evidencia, hallazgoAuditado.evidencia]);
  assert.doesNotMatch(JSON.stringify(auditorias), /(?:id|token|detalle|categoria|contenido)-privado-fixture/);
  assert.equal((await readdir(join(primera.turno, "evidencias"))).length, 2);
  const hallazgo = await leer(join(primera.turno, "hallazgos", `${primera.resultados.at(-1).auditId}.json`));
  assert.equal(hallazgo.resultado.estado, "hipotesis");
  assert.equal(hallazgo.resultado.evidenceId, primera.resultados.at(-2).auditId);
  for (const archivo of ["eventos.json", "resultado.json"]) {
    assert.doesNotMatch(await readFile(join(primera.turno, archivo), "utf8"), /(?:id|token|contenido)-privado-fixture/);
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

  consultas.length = 0;
  const original = llamada("inspeccionar_postura", { bssid: permitido });
  const repetida = await finalizar(await iniciar({ broker, streamFn: guion(
    [original, { ...llamada("observar_entorno"), id: original.id }, llamada("observar_entorno")],
    [fin],
  ) }));
  assert.deepEqual(consultas, ["inspeccionar_postura", "observar_entorno"]);
  assert.deepEqual(repetida.resultados.map(({ result }) => result.code ?? "authorized"),
    ["authorized", "duplicate_tool_call", "authorized"]);
  assert.equal(new Set(repetida.resultados.map(({ llamadaId }) => llamadaId)).size, 3);
  assert.equal(repetida.resultados[0].result.bssid, permitido);
  assert.equal(repetida.resultados[2].result.observaciones[0].bssid, permitido);

  const claveFixture = "credencial-ficticia-del-proveedor";
  const foundry = await finalizar(await iniciar({
    proyecto: { ...proyecto, config: { llm: { proveedor: "azure-foundry" } } },
    entornoLlm: { FOUNDRY_HOST: "fixture.openai.azure.com", FOUNDRY_DEPLOYMENT: "fixture", FOUNDRY_API_KEY: claveFixture },
    streamFn(modelo, contexto, opciones) {
      assert.equal(modelo.baseUrl, "https://fixture.openai.azure.com/openai/v1");
      assert.equal(opciones.apiKey, claveFixture);
      assert.equal(opciones.maxRetries, 0);
      assert.ok(!JSON.stringify(contexto.messages).includes(claveFixture));
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

  const sensible = "contenido-privado-del-host";
  const radio = {
    nameNow: sensible, interfaces: [{ ifname: sensible, serial: sensible }],
    capabilities: { monitor: { declared: "supported" }, concurrency: { declared: sensible } },
    connectivity: { criticality: "critical", interfaz: sensible },
    probe: { warnings: [{ source: "iw_phy", code: "probe_timeout", message: sensible }] },
  };
  const perfil = { schema: "harwiff-adapter-inventory/v1", status: "partial", warnings: [],
    devices: Array.from({ length: 6 }, () => ({ bus: "usb", deviceId: sensible, phys: [radio] })) };
  let leidas = 0;
  const consulta = await iniciar({ leerInventario: async () => (leidas++, perfil),
    streamFn: guion(
      [llamada("consultar_adaptadores", { interfaz: sensible }), llamada("consultar_adaptadores")],
      (ctx) => {
        const inventario = resultadoDe(ctx, "consultar_adaptadores");
        assert.equal(inventario.origen, "host_readonly");
        assert.equal(inventario.adaptadorSesion, "mock");
        assert.equal(inventario.dispositivos.length, 4);
        assert.equal(inventario.truncado, true);
        assert.equal(inventario.dispositivos[0].radios[0].monitorAnunciado, "supported");
        assert.equal(inventario.dispositivos[0].radios[0].concurrenciaAnunciada, "unknown");
        assert.doesNotMatch(JSON.stringify(inventario), /contenido-privado-del-host/);
        return [fin];
      }),
  });
  const consultada = await finalizar(consulta);
  assert.equal(leidas, 1);
  assert.equal(consultada.resultados[0].result.code, "invalid_arguments");
  const idConsulta = consultada.resultados[1].auditId;
  const auditConsulta = await leerAuditoria(raiz, idConsulta);
  assert.equal(auditConsulta.autorizacion.decision, "ALLOWED");
  assert.deepEqual(auditConsulta.referenciasEvidencia, []);
  assert.equal(auditConsulta.evidencia, undefined);
  await assert.rejects(readdir(join(consultada.turno, "evidencias")), { code: "ENOENT" });
  assert.doesNotMatch(JSON.stringify([consultada, auditConsulta]), /contenido-privado-del-host|dispositivo-1/);
  await enviarMensajeAgente({ proyecto, item: consulta, texto: "Revisar el resultado de la consulta",
    entornoLlm: {}, streamFn: guion(
      (ctx) => {
        const historial = ctx.messages.map(({ content }) => JSON.stringify(content)).join(" ");
        assert.match(historial, /consulta_auditada/);
        assert.doesNotMatch(historial, /dispositivo-1|evidenceId/);
        return [llamada("registrar_hallazgo", { ...argsHallazgo, evidenceId: idConsulta })];
      },
      [fin],
    ),
  });
  assert.equal((await finalizar(consulta)).resultados.at(-1).result.code, "evidence_denied");

  leidas = 0;
  const limiteInventario = await finalizar(await iniciar({ leerInventario: async () => (leidas++, perfil),
    streamFn: guion(Array.from({ length: 9 }, () => llamada("consultar_adaptadores"))),
  }));
  assert.equal(leidas, 8);
  assert.equal(limiteInventario.datos.reason, "tool_limit");
  assert.equal(limiteInventario.resultados.at(-1).result.code, "tool_limit");

  const inventarioEmpezado = Promise.withResolvers();
  const inventarioLiberado = Promise.withResolvers();
  const inventarioRevocado = await iniciar({
    streamFn: guion([llamada("consultar_adaptadores")]),
    leerInventario: async () => {
      inventarioEmpezado.resolve();
      await inventarioLiberado.promise;
      return perfil;
    },
  });
  await inventarioEmpezado.promise;
  try {
    await guardarAlcance(proyecto, alternativa);
    await guardarAlcance(proyecto, scope);
  } finally {
    inventarioLiberado.resolve();
  }
  const consultaRevocada = await finalizar(inventarioRevocado);
  assert.equal(consultaRevocada.datos.reason, "scope_changed");
  assert.deepEqual(consultaRevocada.resultados[0].result, { ok: false, code: "scope_changed" });
  assert.equal((await leerAuditoria(raiz, consultaRevocada.resultados[0].auditId)).consultaInventario, undefined);
  const revisionAntesDeBroker = (await leerControlWifi(proyecto)).revision;

  const inventarioPendiente = Promise.withResolvers();
  const inventarioCancelado = await iniciar({
    streamFn: guion([llamada("consultar_adaptadores")]),
    leerInventario: async (signal) => {
      inventarioPendiente.resolve();
      await esperar(30_000, undefined, { signal });
    },
  });
  await inventarioPendiente.promise;
  inventarioCancelado.controlador.abort();
  const consultaCancelada = await finalizar(inventarioCancelado);
  assert.equal(consultaCancelada.datos.status, "cancelled");
  const cancelacionInventario = await leerAuditoria(raiz, consultaCancelada.resultados[0].auditId);
  assert.equal(cancelacionInventario.estado, "cancelado");
  assert.deepEqual(cancelacionInventario.referenciasEvidencia, []);

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
    assert.equal((await leerControlWifi(proyecto)).revision, revisionAntesDeBroker + 2);
  } finally {
    continuar.resolve();
  }
  const descartada = await finalizar(revocada);
  assert.equal(descartada.datos.status, "error");
  assert.equal(descartada.datos.reason, "scope_changed");
  assert.equal(descartada.resultados[0].result.code, "scope_changed");
  const auditoriaRevocada = await leerAuditoria(raiz, descartada.resultados[0].auditId);
  assert.equal(auditoriaRevocada.estado, "bloqueado");
  assert.deepEqual(auditoriaRevocada.autorizacion, { decision: "DENIED", motivo: "scope_changed" });
  assert.deepEqual(auditoriaRevocada.referenciasEvidencia, []);
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
  const auditoriaCancelada = await leerAuditoria(raiz, cancelacion.resultados[0].auditId);
  assert.equal(auditoriaCancelada.estado, "cancelado");
  assert.deepEqual(auditoriaCancelada.autorizacion, { decision: "ALLOWED", motivo: "cancelled" });
  await assert.rejects(readdir(join(cancelacion.turno, "evidencias")), { code: "ENOENT" });

  const canceladaAntes = await finalizar(await iniciar({
    streamFn: guion([llamada("observar_entorno")]),
    broker: () => assert.fail("Se invocó el broker tras la cancelación"),
    alCambiar(item) {
      if (item.actividad === "observar_entorno") item.controlador?.abort();
    },
  }));
  assert.equal(canceladaAntes.datos.status, "cancelled");
  const auditoriaAntes = await leerAuditoria(raiz, canceladaAntes.resultados[0].auditId);
  assert.equal(auditoriaAntes.llamadaId, canceladaAntes.resultados[0].llamadaId);
  assert.deepEqual(auditoriaAntes.autorizacion, { decision: "DENIED", motivo: "cancelled" });
  assert.deepEqual(auditoriaAntes.referenciasEvidencia, []);

  const fallaBroker = await finalizar(await iniciar({
    streamFn: guion([llamada("observar_entorno")]),
    broker() {
      throw Object.assign(new Error("error-privado-fixture"), { publico: "detalle-privado-fixture" });
    },
  }));
  const auditoriaFallida = await leerAuditoria(raiz, fallaBroker.resultados[0].auditId);
  assert.equal(auditoriaFallida.estado, "error");
  assert.deepEqual(auditoriaFallida.autorizacion, { decision: "ALLOWED", motivo: "broker_error" });
  assert.doesNotMatch(JSON.stringify(auditoriaFallida), /privado-fixture/);

  const datosInterrumpidos = { ...primera.datos, status: "running", reason: null };
  await guardarJson(join(conDenegacion.dir, "sesion.json"), datosInterrumpidos);
  const recuperada = await cargarSesionAutonoma(conDenegacion.dir, datosInterrumpidos);
  assert.equal(recuperada.estado, "error");
  assert.equal((await estado(conDenegacion)).reason, "interrupted");
  assert.equal((await readdir(join(primera.turno, "evidencias"))).length, 2);
  console.log("Fase 2A · política, broker, secuencias Pi, presupuestos, revocación, cancelación, recuperación e inventario informativo verificados.");
} finally {
  await rm(raiz, { recursive: true, force: true });
}
