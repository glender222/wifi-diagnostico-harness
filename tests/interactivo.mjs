import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as esperar } from "node:timers/promises";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

import { guardarJson, respuestaSimulada } from "../bucle.mjs";
import { entorno } from "../entorno.mjs";
import { leerHistorial } from "../historial-agente.mjs";
import { crearIdAuditoria, guardarAlcance, leerAuditoria, leerJson, usarAdaptador } from "../proyecto.mjs";
import { cargarSesionAutonoma, enviarMensajeAgente, iniciarSesionAgente } from "../sesion-agente.mjs";

const raiz = await mkdtemp(join(tmpdir(), "harwiff-interactivo-"));
const proyecto = { raiz, config: { cliente: "demo" } };
const scope = { allowedBssids: [], allowedSsids: ["LAB_TEST_AP"], allowedChannels: [6] };
const estado = (item) => leerJson(join(item.dir, "sesion.json"));
const historial = (item) => leerHistorial(item.dir);
const ultimo = async (item) => (await historial(item)).at(-1);
const usar = (name, args = {}) => ({ type: "toolCall", id: randomUUID(), name, arguments: args });
const responder = (modelo, text) => respuestaSimulada(modelo, [{ type: "text", text }]);
const iniciar = (opciones) => iniciarSesionAgente({ proyecto, objetivo: "Revisa el escenario", ...opciones });
const enviar = (item, texto, opciones) => enviarMensajeAgente({ proyecto, item, texto, ...opciones });
const incorporados = (eventos) =>
  eventos.filter(({ type, status }) => type === "user_state" && status === "incorporated").map(({ messageId }) => messageId);
const serie = (...pasos) => {
  let siguiente = 0;
  return (modelo, contexto) => pasos[siguiente++](modelo, contexto);
};

try {
  await guardarAlcance(proyecto, scope);
  await usarAdaptador(proyecto, "mock");

  const textoVisible = Promise.withResolvers();
  const cerrarStream = Promise.withResolvers();
  const brokerActivo = Promise.withResolvers();
  const liberarBroker = Promise.withResolvers();
  const primerStream = createAssistantMessageEventStream();
  const item = await iniciar({
    alCambiar(vista) {
      const parcial = vista.transcript.find(({ text }) => text.includes("Respuesta parcial"));
      if (parcial) textoVisible.resolve(parcial.id);
    },
    broker: async (solicitud, signal) => {
      brokerActivo.resolve();
      await liberarBroker.promise;
      return entorno("broker-mock", solicitud, { signal });
    },
    streamFn: serie(async (modelo) => {
      const llamado = await respuestaSimulada(modelo, [usar("observar_entorno")]);
      const result = await llamado.result();
      primerStream.push({ type: "start", partial: { ...result, content: [] } });
      primerStream.push({ type: "text_delta", contentIndex: 0, delta: "Respuesta parcial",
        partial: { ...result, content: [{ type: "text", text: "Respuesta parcial" }] } });
      void cerrarStream.promise.then(() => primerStream.push({ type: "done", reason: "toolUse",
        message: { ...result, content: [{ type: "text", text: "Respuesta parcial y final." }, ...result.content] } }));
      return primerStream;
    }, (modelo, { messages }) => {
      assert.deepEqual(messages.filter(({ role }) => role === "user").map(({ content }) => content),
        ["Revisa el escenario", "Desde el streaming", "Desde la herramienta"]);
      assert.equal(messages.findLast(({ role }) => role === "toolResult").toolName, "observar_entorno");
      return responder(modelo, "Conclusión guardada.");
    }),
  });

  const respuestaId = await textoVisible.promise;
  assert.equal(item.estado, "running");
  const duranteTexto = await enviar(item, "Desde el streaming");
  assert.match(item.mensajes.join("\n"), /Desde el streaming · en cola/);
  assert.ok((await ultimo(item)).eventos.some(({ messageId }) => messageId === duranteTexto));
  cerrarStream.resolve();
  await brokerActivo.promise;
  const duranteHerramienta = await enviar(item, "Desde la herramienta");
  liberarBroker.resolve();
  await item.trabajo;
  const primero = await ultimo(item);
  const ids = incorporados(primero.eventos);
  assert.deepEqual(ids.slice(1), [duranteTexto, duranteHerramienta]);
  assert.equal(item.transcript.filter(({ id }) => id === respuestaId).length, 1);
  assert.equal(item.transcript.find(({ id }) => id === respuestaId).text, "**Harwiff**  Respuesta parcial y final.");
  assert.equal(primero.eventos.filter(({ type }) => type === "response").length, 2);
  const operacion = primero.eventos.find(({ type }) => type === "tool_result");
  const evidenceId = operacion.result.evidenceId;

  const reabierto = await cargarSesionAutonoma(item.dir, await estado(item));
  assert.match(reabierto.mensajes.join("\n"), /Desde la herramienta/);
  const bssid = "AA:BB:CC:11:22:33";
  await enviar(reabierto, "Usa la evidencia anterior para registrar la hipótesis", {
    streamFn: serie((modelo, { messages }) => {
      const contexto = JSON.stringify(messages);
      assert.match(contexto, new RegExp(evidenceId));
      assert.match(contexto, /Conclusión guardada/);
      assert.doesNotMatch(contexto, /"type":"toolCall"/);
      return respuestaSimulada(modelo, [usar("registrar_hallazgo", { bssid, evidenceId, categoria: "prueba", detalle: "hipótesis" })]);
    }, (modelo, { messages }) => {
      assert.equal(JSON.parse(messages.at(-1).content[0].text).ok, true);
      return responder(modelo, "Hallazgo confirmado.");
    }),
  });
  await reabierto.trabajo;
  const segundo = await ultimo(reabierto);
  const resultado = await leerJson(join(item.dir, "turnos", segundo.id, "resultado.json"));
  assert.equal(resultado.iteration, 2);
  assert.equal(resultado.toolAttempts, 1);
  assert.deepEqual(resultado.budget, { requests: 8, tools: 8, timeoutMs: 120000 });
  assert.notEqual(primero.id, segundo.id);
  assert.equal((await leerAuditoria(raiz, segundo.id)).sesion, item.id);
  assert.equal((await leerAuditoria(raiz, segundo.eventos.find(({ type }) => type === "tool_result").auditId))
    .referenciasEvidencia[0].id, evidenceId);

  const evidenciaRuta = join(raiz, operacion.referenciasEvidencia[0].referencia);
  const evidenciaOriginal = await readFile(evidenciaRuta, "utf8");
  await guardarJson(evidenciaRuta, { ...JSON.parse(evidenciaOriginal), sessionId: "ajena" });
  await enviar(reabierto, "Intenta asociar la evidencia alterada", {
    streamFn: serie((modelo, { messages }) => {
      assert.match(JSON.stringify(messages), /evidencia_no_verificada/);
      return respuestaSimulada(modelo, [usar("registrar_hallazgo", { bssid, evidenceId, categoria: "prueba", detalle: "hipótesis" })]);
    }, (modelo, { messages }) => {
      assert.deepEqual(JSON.parse(messages.at(-1).content[0].text), { ok: false, code: "evidence_denied" });
      return responder(modelo, "No se admitió la evidencia.");
    }),
  });
  await reabierto.trabajo;
  assert.equal((await estado(reabierto)).reason, "completed");
  assert.equal((await ultimo(reabierto)).eventos.find(({ type }) => type === "tool_result").result.code, "evidence_denied");

  let handoff;
  let cambio;
  const traspaso = await iniciar({
    alCambiar(vista) {
      if (vista.actividad === "cerrando turno" && !cambio) cambio = enviar(vista, "Llegó durante el cierre").then((id) => { handoff = id; });
    },
    streamFn: serie((modelo) => responder(modelo, "Primera respuesta"),
      (modelo, { messages }) => {
        assert.ok(messages.some(({ content }) => content === "Llegó durante el cierre"));
        return responder(modelo, "Respuesta al mensaje diferido");
      }),
  });
  await traspaso.trabajo;
  await cambio;
  const turnosTraspaso = await historial(traspaso);
  assert.equal(turnosTraspaso.length, 2);
  assert.deepEqual(incorporados(turnosTraspaso[1].eventos), [handoff]);
  assert.equal(traspaso.mensajes.filter((m) => m.includes("Llegó durante el cierre")).length, 1);

  for (const razon of ["cancelled", "timeout", "scope_changed", "iteration_limit"]) {
    const activo = Promise.withResolvers();
    const liberar = Promise.withResolvers();
    let solicitudes = 0;
    const detenido = await iniciar({
      timeoutMs: razon === "timeout" ? 600 : 120000,
      async streamFn(modelo, contexto, { signal }) {
        solicitudes++;
        if (razon === "iteration_limit" && solicitudes < 8) return respuestaSimulada(modelo, [usar("observar_entorno")]);
        activo.resolve();
        const espera = new AbortController();
        try {
          await Promise.race([esperar(60_000, undefined, { signal: AbortSignal.any([signal, espera.signal]) }), liberar.promise]);
        } finally {
          espera.abort();
        }
        return responder(modelo, "Respuesta final");
      },
    });
    await activo.promise;
    const pendiente = await enviar(detenido, "Entrada pendiente");
    if (razon === "cancelled") detenido.controlador.abort();
    if (razon === "scope_changed") {
      await guardarAlcance(proyecto, { ...scope, allowedChannels: [11] });
      await guardarAlcance(proyecto, scope);
    }
    if (razon === "scope_changed" || razon === "iteration_limit") liberar.resolve();
    // AbortSignal.timeout does not keep Node alive by itself.
    const mantener = setTimeout(() => {}, 1500);
    try { await detenido.trabajo; } finally { clearTimeout(mantener); }
    assert.equal((await estado(detenido)).reason, razon);
    const { eventos } = await ultimo(detenido);
    assert.equal(eventos.findLast(({ type, messageId }) => type === "user_state" && messageId === pendiente).status, "not_sent");
    assert.equal(incorporados(eventos).includes(pendiente), false);
    if (razon !== "iteration_limit") assert.equal(detenido.soloConsulta, true);
  }

  await assert.rejects(enviar(reabierto, "La revisión anterior ya no es válida", {
    streamFn: () => assert.fail("La sesión revocada no contacta al modelo."),
  }), { code: "scope_changed" });

  const antigua = await iniciar({ streamFn: (modelo) => responder(modelo, "Respuesta archivada") });
  await antigua.trabajo;
  const estadoAntiguo = await estado(antigua);
  const rutaAntigua = join(antigua.dir, "turnos", estadoAntiguo.turnId, "eventos.json");
  const antiguaV1 = (await leerJson(rutaAntigua)).filter(({ type }) => !["user", "user_state"].includes(type));
  for (const evento of antiguaV1) {
    delete evento.turnNumber;
    delete evento.messageId;
  }
  await guardarJson(rutaAntigua, antiguaV1);
  delete estadoAntiguo.modelId;
  await guardarJson(join(antigua.dir, "sesion.json"), estadoAntiguo);
  const legado = await cargarSesionAutonoma(antigua.dir, estadoAntiguo);
  await enviar(legado, "Continuación del historial legado", {
    streamFn: (modelo, { messages }) => {
      assert.ok(messages.some(({ content }) => content === "Revisa el escenario"));
      assert.ok(messages.some(({ content }) => content[0]?.text === "Respuesta archivada"));
      return responder(modelo, "Historial legado conservado.");
    },
  });
  await legado.trabajo;
  assert.equal((await estado(legado)).reason, "completed");
  assert.deepEqual(await leerJson(rutaAntigua), antiguaV1);

  const interrumpida = await iniciar({ streamFn: (modelo) => responder(modelo, "Completada para simular corte") });
  await interrumpida.trabajo;
  const archivada = await estado(interrumpida);
  const turnoInterrumpido = join(interrumpida.dir, "turnos", archivada.turnId, "eventos.json");
  const eventosInterrumpidos = (await leerJson(turnoInterrumpido)).filter(({ type }) => type !== "end");
  eventosInterrumpidos.push({ type: "user", messageId: "pendiente", text: "Se cortó el proceso", fecha: new Date().toISOString() });
  await guardarJson(turnoInterrumpido, eventosInterrumpidos);
  await guardarJson(join(interrumpida.dir, "sesion.json"), { ...archivada, status: "running" });
  const carpetaInterrumpida = join(interrumpida.dir, "turnos", archivada.turnId);
  await rm(join(carpetaInterrumpida, "resultado.json"));
  await rm(join(raiz, "auditoria", archivada.turnId, "resultado.json"));
  const consultable = await cargarSesionAutonoma(interrumpida.dir, await estado(interrumpida));
  assert.match(consultable.mensajes.join("\n"), /Se cortó el proceso · no enviado/);
  assert.equal(consultable.soloConsulta, true);
  await assert.rejects(enviar(consultable, "Siguiente"), /disponible para consulta/);
  assert.equal((await leerAuditoria(raiz, archivada.turnId)).reason, "interrupted");
  assert.equal((await leerJson(join(carpetaInterrumpida, "resultado.json"))).motivo, "interrupted");
  assert.equal((await leerJson(turnoInterrumpido)).filter(({ type }) => type === "end").length, 1);

  const entreTurnos = await iniciar({ streamFn: (modelo) => responder(modelo, "Turno anterior finalizado") });
  await entreTurnos.trabajo;
  const anterior = await estado(entreTurnos);
  const dirAnterior = join(entreTurnos.dir, "turnos", anterior.turnId);
  const eventosAnteriores = await readFile(join(dirAnterior, "eventos.json"), "utf8");
  const resultadoAnterior = await readFile(join(dirAnterior, "resultado.json"), "utf8");
  const nuevoId = crearIdAuditoria();
  const auditNuevo = join(raiz, "auditoria", nuevoId);
  await mkdir(auditNuevo);
  await guardarJson(join(auditNuevo, "solicitud.json"), {
    esquema: "harwiff-auditoria/v1", id: nuevoId, origen: "agente", sesion: anterior.id,
    operacion: "sesion_mock", scopeId: anterior.scopeId, turnNumber: anterior.turnNumber + 1,
  });
  const sesionEntreTurnos = { ...anterior, admisionAbierta: true };
  const rutaSesion = join(entreTurnos.dir, "sesion.json");
  await guardarJson(rutaSesion, sesionEntreTurnos);
  const reanudada = await cargarSesionAutonoma(entreTurnos.dir, await estado(entreTurnos));
  assert.equal(reanudada.estado, "error");
  assert.equal((await estado(entreTurnos)).turnId, nuevoId);
  assert.equal((await leerAuditoria(raiz, nuevoId)).estado, "error");
  assert.equal((await leerAuditoria(raiz, nuevoId)).reason, "interrupted");
  assert.equal(await readFile(join(dirAnterior, "resultado.json"), "utf8"), resultadoAnterior);
  assert.equal(await readFile(join(dirAnterior, "eventos.json"), "utf8"), eventosAnteriores);
  const rutaEventosNuevo = join(entreTurnos.dir, "turnos", nuevoId, "eventos.json");
  const eventosNuevo = await readFile(rutaEventosNuevo, "utf8");
  assert.deepEqual(JSON.parse(eventosNuevo).filter(({ type }) => type === "end").map(({ reason }) => reason), ["interrupted"]);
  // Simula otro corte después de reparar la auditoría y antes de guardar sesion.json.
  await guardarJson(rutaSesion, sesionEntreTurnos);
  await cargarSesionAutonoma(entreTurnos.dir, await estado(entreTurnos));
  assert.equal((await estado(entreTurnos)).turnId, nuevoId);
  assert.equal(await readFile(rutaEventosNuevo, "utf8"), eventosNuevo);
  console.log("Sesiones interactivas · steering, cierre, recuperación, evidencias y límites verificados.");
} finally {
  await rm(raiz, { recursive: true, force: true });
}
