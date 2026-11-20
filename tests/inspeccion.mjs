import assert from "node:assert/strict";
import {mkdtemp, rm, readFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createModels} from "@earendil-works/pi-ai";
import {openaiProvider} from "@earendil-works/pi-ai/providers/openai";
import {anthropicProvider} from "@earendil-works/pi-ai/providers/anthropic";
import {inspeccionar, interpretarInspeccion} from "../inspeccion.mjs";
import {leerAuditoria, idsAuditoria, guardarAlcance, elegirAdaptadorInspeccion, hashAlcance, crearIdAuditoria} from "../proyecto.mjs";
import {entorno} from "../entorno.mjs";

const raiz = await mkdtemp(join(tmpdir(), "harwiff-inspeccion-"));
const sse = eventos => new Response(eventos.map(evento => "event: " + evento.type + "\ndata: " + JSON.stringify(evento) + "\n\n").join(""),
  {headers: {"content-type": "text/event-stream"}});

function respuesta(modelo, indice, contenido) {
  if (modelo.api === "openai-responses") {
    const inicial = {id: "resp_" + indice, status: "in_progress", model: modelo.id};
    const item = contenido.name ? {type: "function_call", id: "fc_" + indice, call_id: "call_" + indice,
      name: contenido.name, arguments: JSON.stringify(contenido.args), status: "completed"}
      : {type: "message", id: "msg_" + indice, role: "assistant", status: "completed",
        content: [{type: "output_text", text: contenido.text, annotations: []}]};
    return sse([
      {type: "response.created", response: inicial},
      {type: "response.output_item.done", output_index: 0, item},
      {type: "response.completed", response: {...inicial, status: "completed", output: [item],
        usage: {input_tokens: 150, output_tokens: 20, total_tokens: 170}}},
    ]);
  }
  const bloque = contenido.name ? {type: "tool_use", id: "toolu_" + indice, name: contenido.name, input: {}}
    : {type: "text", text: ""};
  const delta = contenido.name ? {type: "input_json_delta", partial_json: JSON.stringify(contenido.args)}
    : {type: "text_delta", text: contenido.text};
  return sse([
    {type: "message_start", message: {id: "msg_" + indice, role: "assistant", model: modelo.id, content: [],
      type: "message", stop_reason: null, stop_sequence: null, usage: {input_tokens: 150, output_tokens: 0}}},
    {type: "content_block_start", index: 0, content_block: bloque},
    {type: "content_block_delta", index: 0, delta},
    {type: "content_block_stop", index: 0},
    {type: "message_delta", delta: {stop_reason: contenido.name ? "tool_use" : "end_turn", stop_sequence: null},
      usage: {output_tokens: 20}},
    {type: "message_stop"},
  ]);
}

function ultimoResultado(payload) {
  if (payload.input) return payload.input.findLast(item => item.type === "function_call_output")?.output;
  const item = payload.messages.flatMap(mensaje => mensaje.content).findLast(bloque => bloque.type === "tool_result");
  return typeof item?.content === "string" ? item.content : item?.content?.[0]?.text;
}

function conexion(provider, pasos, capturas = []) {
  const modelos = createModels();
  modelos.setProvider(provider);
  const modelo = modelos.getModels(provider.id).find(item => item.input.includes("text") && !item.reasoning)
    ?? modelos.getModels(provider.id)[0];
  let indice = 0;
  return {
    modelo, maxContext: modelo.contextWindow, maxOutput: modelo.maxTokens,
    streamFn: (model, context, options) => modelos.streamSimple(model, context, {
      ...options, apiKey: "sk-harwiff-test-secret",
      async fetch(input, init) {
        const request = new Request(input, init);
        const payload = await request.json();
        capturas.push(payload);
        assert.doesNotMatch(JSON.stringify(payload), /sk-harwiff-test-secret|test-private-interface/);
        const paso = pasos[indice++];
        assert.ok(paso, "Solicitud inesperada");
        return respuesta(modelo, indice, await paso(payload, request));
      },
    }),
  };
}

const probar = [
  () => ({name: "comprobar", args: {}}),
  payload => {
    assert.equal(ultimoResultado(payload), "harwiff-confirmado");
    return {text: '{"resultado":"harwiff-confirmado"}'};
  },
];
const radio = {version: 1, origin: "host_readonly", status: "ok", reasons: [], observations: [
  {subject: "host", field: "radio_count", source: "sysfs", scope: "host", value: 1},
]};
let llamadas;
async function broker(op, solicitud) {
  assert.equal(op, "broker-lectura");
  assert.equal(solicitud.operation, "consultar_adaptadores");
  assert.equal(solicitud.network, null);
  llamadas++;
  return radio;
}

try {
  assert.deepEqual(interpretarInspeccion("--inspeccion --interfaz wlp1s0 --red-del-proyecto -- revisar"), {
    nombre: "wlp1s0", historial: false, red: true, objetivo: "revisar",
  });
  assert.throws(() => interpretarInspeccion("--inspeccion --red-del-proyecto -- revisar"), /interfaz/);

  for (const provider of [openaiProvider(), anthropicProvider()]) {
    const capturas = [];
    const conversacion = await inspeccionar({proyecto: {raiz}, idConversacion: crearIdAuditoria(),
      objetivo: "como te llamas?",
      comprobarModelo: async () => assert.fail("La conversación no necesita una prueba de herramienta."),
      broker: async () => assert.fail("La conversación no debe consultar el inventario."),
      conexion: conexion(provider, [payload => {
        const texto = JSON.stringify(payload);
        assert.match(texto, /Eres Harwiff/);
        return {text: '{"version":1,"reply":"Me llamo Harwiff."}'};
      }], capturas)});
    assert.equal(conversacion.motivo, "completed");
    assert.equal(conversacion.respuestaConversacion, "Me llamo Harwiff.");
    assert.deepEqual(conversacion.afirmaciones, []);
    assert.deepEqual(conversacion.lineas, []);
    assert.equal(conversacion.metricas.intentos, 0);
    assert.equal(capturas.length, 1);
  }

  llamadas = 0;
  const idConversacion = crearIdAuditoria();
  const operaciones = [];
  const lecturaEnChat = await inspeccionar({proyecto: {raiz}, idConversacion, historial: true,
    objetivo: "¿Cuántos radios detectas en mi equipo?", broker, alOperacion: operacion => operaciones.push(operacion),
    conexion: conexion(openaiProvider(), [
      () => ({name: "consultar_adaptadores", args: {}}),
      ...probar,
      () => ({text: '{"version":1,"reply":"Tu equipo tiene diez radios."}'}),
      payload => {
        assert.equal(payload.tool_choice, "none");
        const {ref} = JSON.parse(ultimoResultado(payload)).observations[0];
        return {text: JSON.stringify({version: 1, claims: [{kind: "fact", refs: [ref], text: "Hay diez radios."}]})};
      },
    ])});
  assert.equal(lecturaEnChat.motivo, "completed");
  assert.equal(lecturaEnChat.respuestaConversacion, undefined);
  assert.equal(llamadas, 1);
  assert.match(lecturaEnChat.lineas[0], /Radios Wi‑Fi detectados/);
  assert.doesNotMatch(lecturaEnChat.lineas.join("\n"), /diez/);
  assert.match(lecturaEnChat.resumenConversacion, /detectó 1 radio Wi‑Fi/);
  assert.doesNotMatch(JSON.stringify(lecturaEnChat.afirmaciones), /diez/);
  assert.deepEqual(operaciones.map(({id, estado}) => [id, estado]), [[1, "running"], [1, "ok"]]);

  const previo = {estado: "completo", usuario: {content: "¿Cuántos radios detectas en mi equipo?"},
    respuesta: lecturaEnChat.resumenConversacion, scopeId: lecturaEnChat.scopeId, auditoria: lecturaEnChat.turnId};
  const refPrevia = lecturaEnChat.evidencias[0] + "#0";
  const explicada = await inspeccionar({proyecto: {raiz}, idConversacion, historial: true, contextoConversacion: [previo],
    objetivo: "ohh y eso que dice?",
    broker: async () => assert.fail("La explicación no debe repetir la lectura."),
    comprobarModelo: async () => assert.fail("La explicación no necesita una herramienta."),
    conexion: conexion(openaiProvider(), [payload => {
      assert.ok(!payload.tools?.length);
      assert.match(JSON.stringify(payload), /Observaciones históricas verificadas/);
      assert.ok(JSON.stringify(payload).includes(refPrevia));
      return {text: JSON.stringify({version: 1, claims: [{kind: "inference", refs: [refPrevia],
        text: "El sistema reconocía un radio Wi-Fi.", limitation: "No se midió su rendimiento."}]})};
    }])});
  assert.equal(explicada.motivo, "completed");
  assert.equal(explicada.metricas.intentos, 0);
  assert.match(explicada.resumenConversacion, /se basa en la lectura anterior/);
  assert.match(explicada.resumenConversacion, /reconocía un radio/);
  assert.match(explicada.detalleConversacion.join("\n"), /Hecho histórico/);
  assert.deepEqual(explicada.evidencias, lecturaEnChat.evidencias);

  const otraConversacion = await inspeccionar({proyecto: {raiz}, idConversacion: crearIdAuditoria(), historial: true,
    contextoConversacion: [previo], objetivo: "¿Qué es un radio?",
    conexion: conexion(openaiProvider(), [payload => {
      assert.ok(!JSON.stringify(payload).includes(refPrevia));
      return {text: '{"version":1,"reply":"El radio transmite y recibe señales Wi-Fi."}'};
    }])});
  assert.equal(otraConversacion.motivo, "completed");

  let idHistorico;
  for (const provider of [openaiProvider(), anthropicProvider()]) {
    llamadas = 0;
    const capturas = [];
    const resultado = await inspeccionar({proyecto: {raiz}, objetivo: "Dime cuántos radios detectas", broker,
      conexion: conexion(provider, [...probar,
        () => ({name: "consultar_adaptadores", args: {}}),
        payload => {
          const respuesta = JSON.parse(ultimoResultado(payload));
          assert.equal(respuesta.observations[0].value, 1);
          const ref = respuesta.observations[0].ref;
          return {text: JSON.stringify({version: 1, claims: [{kind: "fact", refs: [ref]},
            {kind: "inference", refs: [ref], text: "Podría ser suficiente para el inventario solicitado.",
              limitation: "La muestra refleja este momento."}]})};
        },
      ], capturas)});
    assert.equal(resultado.motivo, "completed", JSON.stringify(resultado));
    assert.equal(resultado.metricas.solicitudes, 2);
    assert.equal(llamadas, 1);
    assert.match(resultado.lineas.join("\n"), /Hecho · Radios Wi‑Fi detectados.* · 1/);
    assert.match(resultado.lineas.join("\n"), /Interpretación del agente/);
    const id = resultado.lineas[0].match(/\[([^#]+)#0\]/)[1];
    idHistorico = id;
    const registro = await leerAuditoria(raiz, id);
    assert.equal(registro.padre, resultado.turnId);
    assert.equal((await leerAuditoria(raiz, resultado.turnId)).conclusion.motivo, "completed");
    assert.equal(JSON.parse(await readFile(join(raiz, registro.evidencia.referencia), "utf8")).resultado.origin, "host_readonly");
    assert.equal(capturas.length, 4);
  }

  llamadas = 0;
  const invalidas = [];
  const incorrecta = await inspeccionar({proyecto: {raiz}, objetivo: "Solo inventario", broker,
    alOperacion: operacion => invalidas.push(operacion),
    conexion: conexion(openaiProvider(), [...probar,
      () => ({name: "consultar_adaptadores", args: {foo: "x"}}),
      payload => {
        assert.equal(JSON.parse(ultimoResultado(payload)).status, "denied");
        return {text: '{"version":1,"claims":[{"kind":"inference","refs":[],"text":"Falso","limitation":"ninguna"}]}'};
      },
      payload => {
        assert.equal(payload.tool_choice, "none");
        return {text: '{"version":1,"claims":[{"kind":"unknown","field":"radio_count"}]}'};
      },
    ])});
  assert.equal(llamadas, 0);
  assert.ok(invalidas.length && invalidas.every(operacion => operacion.estado === "denied" && !operacion.parametros));
  assert.doesNotMatch(JSON.stringify(invalidas), /"foo"/);
  assert.match(incorrecta.lineas.join("\n"), /Incógnita/);
  const audit = await Promise.all((await idsAuditoria(raiz)).map(id => leerAuditoria(raiz, id)));
  assert.ok(audit.some(x => x.operacion === "tool_denied" && x.estado === "bloqueado"));

  llamadas = 0;
  const controlador = new AbortController();
  const cancelada = await inspeccionar({proyecto: {raiz}, objetivo: "Inspección con cancelación", signal: controlador.signal,
    conexion: conexion(anthropicProvider(), [...probar, () => ({name: "consultar_adaptadores", args: {}})]),
    broker: async (...args) => {
      controlador.abort();
      return broker(...args);
    }});
  assert.equal(cancelada.motivo, "cancelled");
  assert.match(cancelada.lineas.join(" "), /Incógnita/);

  const historial = await inspeccionar({proyecto: {raiz}, objetivo: "Recupera el inventario anterior", broker, historial: true,
    conexion: conexion(anthropicProvider(), [...probar,
      () => ({name: "consultar_evidencia", args: {id: idHistorico}}),
      payload => {
        const datos = JSON.parse(ultimoResultado(payload)).observations;
        assert.equal(datos[0].state, "historical");
        return {text: JSON.stringify({version: 1, claims: [{kind: "fact", refs: [datos[0].ref]}]})};
      },
    ])});
  assert.match(historial.lineas.join(" "), /Hecho histórico/);

  const contradictorio = await inspeccionar({proyecto: {raiz}, objetivo: "Cuenta los radios", broker: async () => ({
    ...radio, observations: [...radio.observations, {...radio.observations[0], source: "nl80211", value: 2}],
  }), conexion: conexion(openaiProvider(), [...probar,
    () => ({name: "consultar_adaptadores", args: {}}),
    payload => {
      const datos = JSON.parse(ultimoResultado(payload)).observations;
      assert.ok(datos.every(dato => dato.state === "conflicting"));
      return {text: JSON.stringify({version: 1, claims: [{kind: "fact", refs: [datos[0].ref]}]})};
    },
    () => ({text: '{"version":1,"claims":[{"kind":"unknown","field":"radio_count"}]}'}),
  ])});
  assert.match(contradictorio.lineas.join(" "), /fuentes discrepan/);
  assert.doesNotMatch(contradictorio.lineas.join(" "), /Hecho/);

  const alcance = {allowedSsids: ["LAB_AUTORIZADO"], allowedBssids: [], allowedChannels: []};
  const autorizado = await guardarAlcance({raiz}, alcance);
  const revocada = conexion(openaiProvider(), [...probar, () => ({name: "inspeccionar_enlace", args: {interfaz: "i1"}})]);
  await assert.rejects(inspeccionar({proyecto: {raiz}, objetivo: "Lee el enlace", nombre: "wlan-test", red: true,
    conexion: revocada, broker: async op => {
      if (op === "vincular-inspeccion") return {identity: "a".repeat(64)};
      await guardarAlcance({raiz}, {...alcance, allowedSsids: ["OTRA_RED"]});
      return {...radio, observations: [{subject: "i1", field: "association", source: "nm_cache", scope: "network", value: "associated"}]};
    }}), {code: "scope_changed"});
  assert.equal((await Promise.all((await idsAuditoria(raiz)).map(id => leerAuditoria(raiz, id))))
    .filter(item => item.operacion === "inspeccionar_enlace" && item.evidencia).length, 0);
  await assert.rejects(inspeccionar({proyecto: {raiz}, objetivo: "Lee el enlace", nombre: "wlan-test", red: true,
    permisoRed: {revision: autorizado.revision, hash: hashAlcance(autorizado)},
    broker: async () => assert.fail("Se intentó ejecutar una lectura con el permiso revocado.")}),
  /El alcance autorizado cambió/);

  if (process.env.HARWIFF_TEST_HOST === "1") {
    const perfil = await entorno("adaptadores-perfil", undefined, {soloLectura: true});
    const nombre = perfil.devices.find(d => d.bus === "pci")?.phys.find(p => p.connectivity.criticality === "critical")?.interfaces[0]?.ifname;
    assert.ok(nombre, "Hace falta una interfaz PCIe crítica para la prueba física.");
    const {inspectionAdapter} = await elegirAdaptadorInspeccion({raiz}, nombre);
    const fisico = await inspeccionar({proyecto: {raiz}, objetivo: "Revisa la ruta IPv4 de la interfaz elegida", nombre,
      adaptadorIdEsperado: inspectionAdapter.id,
      conexion: conexion(anthropicProvider(), [...probar,
        () => ({name: "inspeccionar_enlace", args: {interfaz: "i1"}}),
        payload => {
          const datos = JSON.parse(ultimoResultado(payload)).observations;
          const ruta = datos.find(x => x.field === "ipv4_route" && x.value === "direct");
          assert.ok(ruta, JSON.stringify(datos));
          assert.ok(datos.every(x => x.scope === "host"));
          return {text: JSON.stringify({version: 1, claims: [{kind: "fact", refs: [ruta.ref]}]})};
        },
      ])});
    assert.equal(fisico.motivo, "completed");
    assert.match(fisico.lineas.join(" "), /Ruta por defecto IPv4/);
    console.log("PCIe crítico verificado con broker físico y transporte LLM simulado.");
  }

  const limite = await inspeccionar({proyecto: {raiz}, objetivo: "Límite", broker,
    conexion: conexion(openaiProvider(), probar), presupuesto: {bytes: 256}});
  assert.equal(limite.motivo, "budget_limit");
  assert.equal(limite.metricas.solicitudes, 0);
  console.log("Inspección · dos protocolos Pi, evidencia, corrección, límites y cancelación verificados.");
} finally {
  await rm(raiz, {recursive: true, force: true});
}
