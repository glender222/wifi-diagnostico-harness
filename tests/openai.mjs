import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { comprobarHerramientasOpenAI, listarModelosOpenAI, validarModeloOpenAI } from "../proveedor-openai.mjs";
import { guardarAlcance, leerAuditoria, usarAdaptador } from "../proyecto.mjs";
import { cargarSesionAutonoma, enviarMensajeAgente, iniciarSesionAgente, proveedorAgente } from "../sesion-agente.mjs";

const raiz = await mkdtemp(join(tmpdir(), "harwiff-openai-"));
const modelId = "gpt-4.1-mini";
const modeloDevuelto = "gpt-4.1-mini-2025-04-14";
const clave = "sk-credencial-ficticia-harwiff";
const entorno = { OPENAI_API_KEY: clave, OPENAI_ORG_ID: "org-fixture", OPENAI_PROJECT_ID: "proj-fixture" };
const config = { esquema: "wifi-proyecto/v1", cliente: "demo", llm: { proveedor: "openai", openaiModelId: modelId } };
const proyecto = { raiz, config };
const bssid = "AA:BB:CC:11:22:33";
const scope = { allowedBssids: [], allowedSsids: ["LAB_TEST_AP"], allowedChannels: [6], maxIterations: 8 };
const objetivo = "Revisar la postura del escenario sintético";
const leer = async (ruta) => JSON.parse(await readFile(ruta, "utf8"));
const baseApi = "https://api.openai.com/v1";
const listado = () => Response.json({ data: [{ id: "whisper-1" }, { id: modelId }, { id: "gpt-5-mini" }] });
const modeloNuevo = "gpt-6.2-sol";
const catalogoNuevo = () => Response.json({ data: [
  { id: "whisper-1", created: 1 }, { id: modeloNuevo, created: 3 }, { id: "ft:gpt-4.1-mini:proyecto:prueba", created: 2 },
  { id: modeloNuevo, created: 3 }, { id: "\n" },
] });

function valorHttp(input, init) {
  const request = new Request(input, init);
  assert.equal(request.headers.get("authorization"), `Bearer ${clave}`);
  assert.equal(request.headers.get("openai-organization"), "org-fixture");
  assert.equal(request.headers.get("openai-project"), "proj-fixture");
  assert.equal(request.redirect, "error");
  return request;
}

function api({ pasos, solicitudes = [], id = modelId, catalogo = listado }) {
  let i = 0;
  return async (input, init) => {
    const request = valorHttp(input, init);
    if (request.url === `${baseApi}/models`) {
      assert.equal(request.method, "GET");
      return catalogo();
    }
    assert.equal(request.url, `${baseApi}/responses`);
    assert.equal(request.method, "POST");
    const payload = await request.json();
    solicitudes.push(payload);
    assert.equal(payload.model, id);
    assert.equal(payload.store, false);
    assert.equal(payload.stream, true);
    assert.equal(payload.max_output_tokens, 2048);
    assert.ok(payload.tool_choice === undefined || payload.tool_choice === "auto");
    const herramientas = [...(payload.tools ?? []), ...payload.input
      .filter(({ type }) => type === "additional_tools").flatMap(({ tools }) => tools)];
    assert.deepEqual(herramientas.map(({ name }) => name), ["observar_entorno", "inspeccionar_postura", "registrar_hallazgo", "consultar_adaptadores"]);
    assert.doesNotMatch(JSON.stringify(payload), new RegExp(clave));
    return pasos[i++](payload, request);
  };
}

function sse(...eventos) {
  const cuerpo = eventos.map((evento) => `event: ${evento.type}\ndata: ${JSON.stringify(evento)}\n\n`).join("");
  return new Response(cuerpo, { headers: { "Content-Type": "text/event-stream" } });
}

function respuesta(numero, item, entrada = 12, salida = 3) {
  const inicial = { id: `resp_${numero}`, status: "in_progress", model: modeloDevuelto };
  const final = { ...inicial, status: "completed", output: [item],
    usage: { input_tokens: entrada, output_tokens: salida, total_tokens: entrada + salida } };
  const completada = { type: "response.completed", response: final };
  return sse({ type: "response.created", response: inicial },
    { type: "response.output_item.done", output_index: 0, item }, completada, completada);
}

function herramienta(numero, name, args = {}) {
  return { type: "function_call", id: `fc_${numero}`, call_id: `call_${numero}`,
    name, arguments: JSON.stringify(args), status: "completed" };
}

function mensaje(numero, text = "Terminé de revisar el escenario.") {
  return { type: "message", id: `msg_${numero}`, role: "assistant",
    status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
}

function iniciar(fetchOpenAI, opciones = {}) {
  return iniciarSesionAgente({ proyecto, objetivo, entornoLlm: entorno, fetchOpenAI, ...opciones });
}

async function finalizar(item) {
  await item.trabajo;
  const estado = await leer(join(item.dir, "sesion.json"));
  const rutaTurno = join(item.dir, "turnos", estado.turnId);
  const eventos = await leer(join(rutaTurno, "eventos.json"));
  const resultado = await leer(join(rutaTurno, "resultado.json"));
  const herramientas = eventos.filter(({ type }) => type === "tool_result");
  return { estado, eventos, resultado, herramientas };
}

try {
  await assert.rejects(listarModelosOpenAI({ entorno: {}, fetchFn: () => assert.fail() }), { code: "openai_key_missing" });
  await assert.rejects(listarModelosOpenAI({ entorno: { OPENAI_API_KEY: "oauth-falso" }, fetchFn: () => assert.fail() }),
    { code: "openai_key_invalid" });
  await assert.rejects(validarModeloOpenAI("id con espacios", { entorno, fetchFn: () => assert.fail() }),
    { code: "openai_model_incompatible" });
  assert.deepEqual(await listarModelosOpenAI({ entorno, fetchFn: async (input, init) => {
    assert.equal(valorHttp(input, init).url, `${baseApi}/models`);
    return listado();
  } }), ["whisper-1", modelId, "gpt-5-mini"]);
  assert.deepEqual(await listarModelosOpenAI({ entorno, fetchFn: async () => catalogoNuevo() }),
    [modeloNuevo, "ft:gpt-4.1-mini:proyecto:prueba", "whisper-1"]);
  assert.equal((await validarModeloOpenAI("whisper-1", { entorno, fetchFn: async () => listado() })).modelo.id, "whisper-1");
  await assert.rejects(comprobarHerramientasOpenAI("whisper-1", { entorno, fetchFn: async (url) =>
    url.endsWith("/models") ? listado() : Response.json({ error: { param: "model" } }, { status: 400 }) }),
  { code: "openai_request" });
  await assert.rejects(validarModeloOpenAI("gpt-5.4-mini", { entorno, fetchFn: async () => listado() }), { code: "openai_model_access" });
  for (const [status, code, esperado] of [[401, "invalid_api_key", "openai_key_invalid"],
    [403, "permission_denied", "openai_model_access"], [429, "credit_balance_exhausted", "openai_quota"],
    [429, "rate_limit_exceeded", "openai_rate_limit"], [503, "server_error", "openai_service"]]) {
    await assert.rejects(listarModelosOpenAI({
      entorno, fetchFn: async () => Response.json({ error: { code, message: clave } }, { status }),
    }), (error) => error.code === esperado && !error.message.includes(clave));
  }
  await assert.rejects(listarModelosOpenAI({ entorno, fetchFn: async () => { throw new Error(clave); } }),
    { code: "openai_connection" });
  assert.equal(proveedorAgente({ ...config, llm: { proveedor: "demo" } }, { ...entorno, FOUNDRY_API_KEY: "fixture" }), "demo");
  assert.equal(proveedorAgente({ ...config, llm: { proveedor: "azure-foundry" } }, entorno), "azure-foundry");

  await guardarAlcance(proyecto, scope);
  await usarAdaptador(proyecto, "mock");
  await assert.rejects(iniciar(async () => listado(), { entornoLlm: {} }), { code: "openai_key_missing" });
  await assert.rejects(readdir(join(raiz, "agentes")), { code: "ENOENT" });

  const solicitudes = [];
  const primera = await finalizar(await iniciar(api({ solicitudes, pasos: [
    () => respuesta(1, herramienta(1, "observar_entorno"), 11, 2),
    () => respuesta(2, herramienta(2, "inspeccionar_postura", { bssid }), 20, 4),
    (payload) => {
      const informe = JSON.parse(payload.input.findLast(({ type }) => type === "function_call_output").output);
      assert.equal(informe.bssid, bssid);
      return respuesta(3, herramienta(3, "registrar_hallazgo", {
        bssid, categoria: "postura", detalle: `Detalle con ${clave}`, evidenceId: informe.evidenceId,
      }), 30, 7);
    },
    () => respuesta(4, mensaje(4, `Confirmé la postura. ${clave}`), 40, 9),
  ] }), { objetivo: `${objetivo} ${clave}` }));
  assert.equal(primera.estado.status, "completed",
    `${primera.estado.reason}, solicitudes enviadas: ${solicitudes.length}`);
  assert.equal(primera.estado.provider, "openai");
  assert.equal(primera.resultado.modelId, modelId);
  assert.equal(solicitudes.length, 4);
  assert.deepEqual(primera.herramientas.map(({ tool }) => tool),
    ["observar_entorno", "inspeccionar_postura", "registrar_hallazgo"]);
  assert.deepEqual(primera.resultado.consumo, { modelosDevueltos: [modeloDevuelto], tokens: { entrada: 101, salida: 22, total: 123 },
    solicitudes: 4, respuestasConUso: 4, estado: "completo" });
  const hallazgo = await leerAuditoria(raiz, primera.herramientas[2].auditId);
  assert.equal(hallazgo.autorizacion.decision, "ALLOWED");
  assert.doesNotMatch(JSON.stringify([primera, hallazgo, await leer(join(raiz, hallazgo.evidencia.referencia))]), new RegExp(clave));

  const razonador = "o4-mini";
  const proyectoRazonador = { ...proyecto, config: { ...config, llm: { proveedor: "openai", openaiModelId: razonador } } };
  const catalogo = () => Response.json({ data: [{ id: razonador }] });
  const razonamiento = { type: "reasoning", id: "rs_fixture", encrypted_content: "cifrado-fixture",
    summary: [{ type: "summary_text", text: "Resumen oficial del proveedor." }] };
  const privada = "Pensamiento privado de prueba";
  const parcial = { ...razonamiento, summary: [] };
  const llamada = herramienta(30, "observar_entorno");
  const inicial = { id: "resp_razonador", status: "in_progress", model: razonador };
  const finConHerramienta = { ...inicial, status: "completed", output: [razonamiento, llamada],
    usage: { input_tokens: 9, output_tokens: 5, total_tokens: 14 } };
  const conRazonamiento = await iniciar(api({ id: razonador, catalogo, pasos: [
    (payload) => {
      assert.deepEqual(payload.reasoning, { summary: "detailed", effort: "low" });
      assert.ok(payload.include.includes("reasoning.encrypted_content"));
      return sse({ type: "response.created", response: inicial },
        { type: "response.output_item.added", output_index: 0, item: parcial },
        { type: "response.reasoning_text.delta", output_index: 0, delta: privada },
        { type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0,
          delta: "Resumen oficial" },
        { type: "response.output_item.done", output_index: 0,
          item: { ...razonamiento, content: [{ type: "reasoning_text", text: privada }] } },
        { type: "response.output_item.done", output_index: 1, item: llamada },
        { type: "response.completed", response: finConHerramienta });
    },
    (payload) => {
      const historial = payload.input.filter(({ type }) => ["reasoning", "function_call", "function_call_output"].includes(type));
      assert.deepEqual(historial.map(({ type }) => type), ["reasoning", "function_call", "function_call_output"]);
      assert.equal(historial[0].encrypted_content, razonamiento.encrypted_content);
      assert.equal(historial[1].call_id, historial[2].call_id);
      return respuesta(31, mensaje(31, "Contexto visible conservado."));
    },
  ] }), { proyecto: proyectoRazonador });
  const turnoCifrado = await finalizar(conRazonamiento);
  assert.equal(turnoCifrado.estado.reason, "completed");
  assert.equal(turnoCifrado.eventos.find(({ type }) => type === "summary").text, "Resumen oficial del proveedor.");
  assert.doesNotMatch(JSON.stringify([turnoCifrado, conRazonamiento.transcript]), /Pensamiento privado|cifrado-fixture/);
  const reabierta = await cargarSesionAutonoma(conRazonamiento.dir, turnoCifrado.estado);
  await enviarMensajeAgente({ proyecto, item: reabierta, texto: "Contrasta lo observado con la postura del escenario",
    entornoLlm: entorno, fetchOpenAI: api({ id: razonador, catalogo, pasos: [
      (payload) => {
        assert.match(JSON.stringify(payload.input), /Contexto visible conservado/);
        assert.match(JSON.stringify(payload.input), /Datos históricos de Harwiff/);
        assert.ok(!payload.input.some(({ type }) => ["reasoning", "function_call", "function_call_output"].includes(type)));
        return respuesta(32, herramienta(32, "inspeccionar_postura", { bssid }));
      },
      (payload) => {
        assert.equal(payload.input.findLast(({ type }) => type === "function_call_output").call_id, "call_32");
        return respuesta(33, mensaje(33, "Segunda respuesta con herramientas."));
      },
    ] }),
  });
  const reanudada = await finalizar(reabierta);
  assert.equal(reanudada.estado.modelId, razonador);
  assert.equal(reanudada.estado.reason, "completed");
  assert.equal(reanudada.herramientas[0].tool, "inspeccionar_postura");

  const alternativa = await finalizar(await iniciar(api({ pasos: [
    () => respuesta(1, herramienta(1, "inspeccionar_postura", { bssid })),
    () => respuesta(2, herramienta(2, "observar_entorno")),
    () => respuesta(3, mensaje(3)),
  ] })));
  assert.equal(alternativa.estado.status, "completed");
  assert.deepEqual(alternativa.herramientas.map(({ tool }) => tool), ["inspeccionar_postura", "observar_entorno"]);

  const proyectoModeloNuevo = { ...proyecto, config: { ...config,
    llm: { proveedor: "openai", openaiModelId: modeloNuevo } } };
  const nuevaSesion = await finalizar(await iniciar(api({ id: modeloNuevo, catalogo: catalogoNuevo, pasos: [
    (payload) => {
      assert.ok(payload.include.includes("reasoning.encrypted_content"));
      return respuesta(1, herramienta(1, "observar_entorno"));
    },
    (payload) => {
      assert.ok(payload.input.some(({ type }) => type === "function_call_output"));
      return respuesta(2, mensaje(2));
    },
  ] }), { proyecto: proyectoModeloNuevo }));
  assert.equal(nuevaSesion.estado.status, "completed");
  assert.equal(nuevaSesion.resultado.modelId, modeloNuevo);
  assert.deepEqual(nuevaSesion.herramientas.map(({ tool }) => tool), ["observar_entorno"]);

  const luna = "gpt-6-luna";
  const proyectoLuna = { ...proyecto, config: { ...config, llm: { proveedor: "openai", openaiModelId: luna } } };
  const catalogoLuna = () => Response.json({ data: [{ id: luna }] });
  const simularLuna = (pasos) => api({ id: luna, catalogo: catalogoLuna, pasos });
  const conLuna = await iniciar(simularLuna([
    (payload) => {
      assert.ok(!payload.reasoning?.summary);
      return respuesta(41, herramienta(41, "observar_entorno"));
    },
    (payload) => {
      assert.ok(!payload.reasoning?.summary);
      assert.ok(payload.input.some(({ type }) => type === "function_call_output"));
      return respuesta(42, mensaje(42));
    },
  ]), { proyecto: proyectoLuna });
  const sinResumenLuna = await finalizar(conLuna);
  assert.equal(sinResumenLuna.estado.reason, "completed");
  assert.equal(sinResumenLuna.estado.modelId, luna);
  assert.equal(sinResumenLuna.eventos[0].resumenSolicitado, false);
  assert.ok(sinResumenLuna.herramientas.some(({ tool }) => tool === "observar_entorno"));
  assert.match(conLuna.mensajes.join("\n"), /Resumen oficial de OpenAI · no disponible/);

  const resumenEntregado = await iniciar(simularLuna([(payload) => {
    assert.ok(!payload.reasoning?.summary);
    const item = mensaje(43, "Respuesta con un resumen entregado por el proveedor.");
    const reasoning = { ...razonamiento, content: [{ type: "reasoning_text", text: privada }] };
    return sse({ type: "response.created", response: { id: "resp_luna", model: luna, status: "in_progress" } },
      { type: "response.output_item.done", output_index: 1, item },
      { type: "response.completed", response: { id: "resp_luna", status: "completed", model: luna,
        output: [reasoning, item], usage: { input_tokens: 5, output_tokens: 4, total_tokens: 9 } } });
  }]), { proyecto: proyectoLuna });
  const conResumenLuna = await finalizar(resumenEntregado);
  assert.equal(conResumenLuna.estado.reason, "completed");
  assert.equal(conResumenLuna.eventos.find(({ type }) => type === "summary")?.text, razonamiento.summary[0].text);
  assert.doesNotMatch(resumenEntregado.mensajes.join("\n"), /soporte sin confirmar/);
  assert.doesNotMatch(JSON.stringify([conResumenLuna, resumenEntregado.transcript]), /Pensamiento privado|cifrado-fixture/);

  const astra = "gpt-6.2-astra";
  const proyectoAstra = { ...proyecto, config: { ...config, llm: { proveedor: "openai", openaiModelId: astra } } };
  const conAstra = await finalizar(await iniciar(api({ id: astra, catalogo: () => Response.json({ data: [{ id: astra }] }),
    pasos: [(payload) => {
      assert.deepEqual(payload.reasoning, { effort: "low", summary: "auto" });
      return respuesta(44, mensaje(44));
    }],
  }), { proyecto: proyectoAstra }));
  assert.equal(conAstra.estado.reason, "completed");
  assert.equal(conAstra.eventos[0].resumenSolicitado, true);

  const cuota = await finalizar(await iniciar(api({ pasos: [
    () => respuesta(1, herramienta(1, "observar_entorno")),
    () => Response.json({ error: { code: "insufficient_quota", message: clave } }, { status: 429 }),
  ] })));
  assert.equal(cuota.estado.status, "error");
  assert.equal(cuota.estado.reason, "openai_quota");
  assert.deepEqual(cuota.resultado.consumo.tokens, { entrada: 12, salida: 3, total: 15 });
  assert.equal(cuota.resultado.consumo.estado, "parcial");
  const cuotaAuditada = await leerAuditoria(raiz, cuota.estado.turnId);
  assert.equal(cuotaAuditada.estado, "error");
  assert.match(cuotaAuditada.motivo, /cuota/);
  assert.doesNotMatch(JSON.stringify([cuota, cuotaAuditada]), new RegExp(clave));

  const acceso = await finalizar(await iniciar(api({ pasos: [
    () => sse({ type: "response.failed", response: { error: { code: "model_not_found", message: clave } } }),
  ] })));
  assert.equal(acceso.estado.reason, "openai_model_access");
  assert.equal(acceso.resultado.consumo.tokens, null);
  assert.equal(acceso.resultado.consumo.estado, "no_disponible");
  assert.doesNotMatch(JSON.stringify(acceso), new RegExp(clave));

  const cortada = await finalizar(await iniciar(api({ pasos: [
    () => sse({ type: "response.created", response: { id: "resp_cortada", model: modeloDevuelto } }),
  ] })));
  assert.equal(cortada.estado.reason, "openai_connection");
  assert.equal(cortada.resultado.consumo.tokens, null);

  const revocada = await finalizar(await iniciar(api({ pasos: [async () => {
    await guardarAlcance(proyecto, { ...scope, allowedSsids: ["LAB_FUERA"], allowedChannels: [11] });
    return respuesta(1, herramienta(1, "observar_entorno"));
  }] }), { broker: () => assert.fail("Se intentó ejecutar el broker fuera del alcance vigente") }));
  assert.equal(revocada.estado.reason, "scope_changed");
  assert.equal(revocada.herramientas[0].result.code, "scope_changed");
  assert.equal(revocada.resultado.consumo.tokens.total, 15);
  await guardarAlcance(proyecto, scope);

  const esperando = Promise.withResolvers();
  const pendiente = await iniciar(api({ pasos: [(_payload, request) => {
    esperando.resolve();
    return new Promise((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
    });
  }] }));
  await esperando.promise;
  pendiente.controlador.abort();
  const cancelada = await finalizar(pendiente);
  assert.equal(cancelada.estado.status, "cancelled");
  assert.equal(cancelada.estado.reason, "cancelled");
  assert.equal(cancelada.resultado.consumo.estado, "no_disponible");

  const rutaManifiesto = join(raiz, "harness.json");
  await writeFile(rutaManifiesto, JSON.stringify({ esquema: config.esquema, cliente: config.cliente }));
  const preload = join(raiz, "preload.mjs");
  await writeFile(preload, `
    globalThis.fetch = async (url, init) => {
      if (url !== "${baseApi}/models" || !new Headers(init.headers).get("authorization")?.startsWith("Bearer sk-")) {
        throw new Error("Solicitud no esperada");
      }
      return Response.json({ data: [{ id: "${modelId}" }, { id: "whisper-1" }] });
    };
  `);
  const python = join(raiz, "python-fixture");
  await writeFile(python, "#!/usr/bin/env python3\nimport os, sys\nif 'OPENAI_API_KEY' in os.environ:\n    sys.exit(93)\nos.execv(sys.executable, [sys.executable, *sys.argv[1:]])\n", { mode: 0o700 });
  const cli = fileURLToPath(new URL("../consola.mjs", import.meta.url));
  const comandos = ["/config proveedor openai", "/config modelos", `/config modelo ${modelId}`,
    `/config modelo ${clave}`, "/config", "/alcance set --ssid LAB_TEST_AP --canales 6", "/salir", ""].join("\n");
  const cliResult = spawnSync(process.execPath, ["--import", preload, cli, raiz], {
    input: comandos, encoding: "utf8", env: { ...process.env, ...entorno, WIFI_PYTHON: python },
  });
  assert.equal(cliResult.status, 0, cliResult.stderr);
  assert.match(cliResult.stdout, /Modelos disponibles en tu proyecto OpenAI: gpt-4\.1-mini \(listado · pendiente de verificar\), whisper-1/);
  assert.match(cliResult.stdout, /Modelo OpenAI guardado: gpt-4\.1-mini/);
  assert.match(cliResult.stdout, /Alcance guardado/);
  assert.doesNotMatch(cliResult.stdout + cliResult.stderr, new RegExp(clave));
  assert.deepEqual(await leer(rutaManifiesto), config);
  console.log("OpenAI simulado · catálogo, herramientas, errores, cancelación, credenciales y resúmenes verificados.");
  console.log(`Modelo simulado: ${modelId} → ${modeloDevuelto}. Tokens simulados: 101 entrada, 22 salida, 123 total.`);
} finally {
  await rm(raiz, { recursive: true, force: true });
}
