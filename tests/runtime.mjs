import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { MODELO_DEMO, demo, leerTurnos, modeloFoundry, responder } from "../bucle.mjs";
import { auditar, guardarInforme, informesAgente, leerAuditoria } from "../proyecto.mjs";

const dir = await mkdtemp(join(tmpdir(), "harwiff-test-"));
try {
  const id = await auditar(dir, { operacion: "diagnostico", motor: "demo-local" }, async (id) => {
    const registro = await leerAuditoria(dir, id);
    assert.equal(registro.estado, "pendiente de cierre");
    return { evidencia: await guardarInforme(dir, id, {
      esquema: "wifi-diagnostico/v1", origen: "demo",
      observaciones: { conectada: true, senal_dbm: -55, ip: "solo-fixture" },
    }) };
  });
  const informes = await informesAgente(dir);
  assert.equal(informes[0].id, id);
  assert.deepEqual(informes[0].observaciones, { conectada: true, senal_dbm: -55 });
  const registro = await leerAuditoria(dir, id);
  assert.equal(registro.estado, "completo");
  assert.equal(registro.evidencia.sha256.length, 64);

  const sesion = join(dir, "agentes", "prueba");
  const emitir = () => {};
  const leerContexto = () => JSON.stringify(informes);
  await responder({ id: "1", sesion, texto: "leer", modelo: MODELO_DEMO, emitir, leerContexto, streamFn: demo });

  const { modelo, clave } = modeloFoundry({}, {
    FOUNDRY_HOST: "test.openai.azure.com", FOUNDRY_DEPLOYMENT: "test", FOUNDRY_API_KEY: "clave-fixture",
  });
  let recuperado = false;
  await responder({
    id: "2", sesion, texto: "continuar", modelo, clave, emitir, leerContexto,
    streamFn(modelo, contexto, opciones) {
      assert.equal(modelo.baseUrl, "https://test.openai.azure.com/openai/v1");
      assert.equal(opciones.apiKey, clave);
      recuperado = contexto.messages.some((m) => m.role === "user" && m.content === "leer");
      const stream = createAssistantMessageEventStream();
      const mensaje = { ...contexto.messages.find((m) => m.role === "assistant"),
        content: [{ type: "text", text: "Respuesta simulada" }], stopReason: "stop" };
      stream.push({ type: "done", reason: "stop", message: mensaje });
      return stream;
    },
  });
  assert.ok(recuperado);
  assert.ok(!(await readFile(join(sesion, "turnos", "2", "resultado.json"), "utf8")).includes(clave));

  await mkdir(join(sesion, "turnos", "3"));
  await writeFile(join(sesion, "turnos", "3", "inicio.json"), '{"usuario":{"content":"Consulta interrumpida"}}');
  const recuperacion = await leerTurnos(sesion);
  assert.equal(recuperacion.at(-1).estado, "interrumpido");
  assert.equal(recuperacion.at(-1).usuario.content, "Consulta interrumpida");

  const control = new AbortController();
  const promesa = responder({
    id: "4", sesion, texto: "cancelar", modelo: MODELO_DEMO, emitir, leerContexto,
    streamFn: demo, signal: control.signal,
  });
  control.abort();
  await assert.rejects(promesa, /Turno interrumpido/);
  assert.equal((await leerTurnos(sesion)).at(-1).estado, "cancelado");
  console.log("Auditoría, recuperación, demo y Foundry simulado verificados.");
} finally {
  await rm(dir, { recursive: true, force: true });
}
