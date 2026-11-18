import assert from "node:assert/strict";
import { crearCredencialesOpenAI } from "../credenciales-openai.mjs";
import { comprobarHerramientasOpenAI } from "../proveedor-openai.mjs";

const clave = "sk-fixture-harwiff-connect";
const externa = "sk-fixture-externa-harwiff";
const modelId = "gpt-4.1-mini";
let almacenada;
let disponible = true;
const ejecutar = async (operacion, entrada) => {
  if (!disponible) return { estado: "no_disponible" };
  if (operacion === "lookup") return almacenada ? { estado: "ok", salida: almacenada } : { estado: "ausente" };
  if (operacion === "clear") {
    almacenada = undefined;
  } else {
    assert.equal(operacion, "store");
    assert.equal(entrada, clave);
    almacenada = entrada;
  }
  return { estado: "ok" };
};

const entorno = { OPENAI_API_KEY: externa };
const gestor = crearCredencialesOpenAI({ entorno, ejecutar });
assert.equal((await gestor.resolver()).fuente, "OPENAI_API_KEY");
assert.equal(await gestor.guardar(clave), "Secret Service");
assert.equal((await gestor.resolver()).entorno.OPENAI_API_KEY, clave);
assert.equal(gestor.ocultar(`${clave} y ${externa}`), "[credencial omitida] y [credencial omitida]");
const reiniciado = crearCredencialesOpenAI({ entorno: {}, ejecutar });
assert.equal((await reiniciado.resolver()).entorno.OPENAI_API_KEY, clave);
assert.equal(await gestor.desvincular(), "ok");
assert.equal(almacenada, undefined);
assert.equal(entorno.OPENAI_API_KEY, externa);
assert.equal((await gestor.resolver()).fuente, "OPENAI_API_KEY");
disponible = false;
assert.equal(await reiniciado.guardar(clave), "memoria de Harwiff");
assert.equal((await reiniciado.resolver()).entorno.OPENAI_API_KEY, clave);
assert.equal(await reiniciado.desvincular(), "no_disponible");
assert.equal((await reiniciado.resolver()).fuente, null);

let contadorPost = 0;
const opciones = (respuesta) => ({
  entorno: { OPENAI_API_KEY: clave },
  fetchFn: async (url, init) => {
    assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${clave}`);
    assert.equal(init.redirect, "error");
    if (url === "https://api.openai.com/v1/models") return Response.json({ data: [{ id: modelId }] });
    assert.equal(url, "https://api.openai.com/v1/responses");
    contadorPost++;
    const payload = JSON.parse(init.body);
    assert.equal(payload.model, modelId);
    assert.equal(payload.store, false);
    assert.equal(payload.max_output_tokens, 512);
    assert.deepEqual(payload.tool_choice, { type: "function", name: "observar_entorno" });
    assert.deepEqual(payload.tools.map(({ name }) => name), ["observar_entorno"]);
    assert.doesNotMatch(init.body, new RegExp(clave));
    return respuesta();
  },
});

const exitosa = {
  status: "completed", model: "gpt-4.1-mini-2025-04-14",
  output: [{ type: "function_call", name: "observar_entorno", arguments: "{}" }],
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
};
assert.deepEqual(await comprobarHerramientasOpenAI(modelId, opciones(() => Response.json(exitosa))),
  { modelId, modeloDevuelto: exitosa.model, herramienta: "observar_entorno", tokens: { entrada: 10, salida: 5, total: 15 } });
assert.equal(contadorPost, 1);
await assert.rejects(comprobarHerramientasOpenAI(modelId, opciones(() => Response.json({ ...exitosa, output: [] }))),
  { code: "openai_probe_tool" });
await assert.rejects(comprobarHerramientasOpenAI(modelId, opciones(() =>
  Response.json({ error: { code: "insufficient_quota", message: clave } }, { status: 429 }))),
  (error) => error.code === "openai_quota" && !error.message.includes(clave));
console.log("Connect simulado · almacén, memoria, desvinculación y prueba de function calling verificados.");
