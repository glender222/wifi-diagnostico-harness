import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

const BASE = "https://api.openai.com/v1";
const modelosPi = new Map(openaiProvider().getModels()
  .filter(({ provider, api, baseUrl }) => provider === "openai" && api === "openai-responses" && baseUrl === BASE)
  .map((modelo) => [modelo.id, modelo]));
// Modelos con soporte explícito en la guía oficial de resúmenes de OpenAI.
const RESUMEN_DOCUMENTADO = /^(?:o4-mini(?:-2025-04-16)?|gpt-6\.2-astra)$/;
const CUOTA = new Set(["insufficient_quota", "billing_hard_limit_reached", "credit_balance_exhausted",
  "organization_spend_limit_exceeded", "project_spend_limit_exceeded", "organization_usage_limit_exceeded"]);

export const MENSAJES_OPENAI = {
  openai_key_missing: "Conecta OpenAI con /connect o define OPENAI_API_KEY en el entorno de Harwiff.",
  openai_key_invalid: "OpenAI rechazó la autenticación. Revisa la clave y sus permisos.",
  openai_model_missing: "Selecciona un modelo con /config modelos y /config modelo <model-id>.",
  openai_model_incompatible: "El ID de modelo no es válido. Consulta /config modelos.",
  openai_model_access: "OpenAI no autoriza el acceso al modelo o a este recurso. Revisa el proyecto y /config modelos.",
  openai_quota: "OpenAI indica que se agotó la cuota, el crédito o el límite de gasto del proyecto.",
  openai_rate_limit: "Se alcanzó el límite de solicitudes o tokens por minuto de OpenAI. Espera antes de reintentar.",
  openai_connection: "No se pudo completar la conexión con la API oficial de OpenAI.",
  openai_service: "El servicio de OpenAI interrumpió la operación. Intenta de nuevo más tarde.",
  openai_request: "OpenAI rechazó la solicitud. Revisa el modelo y su compatibilidad con Responses.",
  openai_tools_unsupported: "El modelo no admite Responses API con llamadas a herramientas.",
  openai_probe_tool: "OpenAI respondió, pero la llamada de comprobación de herramientas quedó incompleta.",
};

function errorOpenAI(code) {
  return Object.assign(new Error(MENSAJES_OPENAI[code]), { code });
}

function codigoOpenAI(status, error) {
  const code = error?.code;
  if (CUOTA.has(code) || CUOTA.has(error?.type)) return "openai_quota";
  if (status === 401 || code === "invalid_api_key") return "openai_key_invalid";
  if (status === 403 || status === 404 || code === "model_not_found" || code === "permission_denied") {
    return "openai_model_access";
  }
  if (status === 429 || code === "rate_limit_exceeded" || code === "slow_down" || error?.type === "rate_limit_error") {
    return "openai_rate_limit";
  }
  if (["unsupported_model", "model_not_supported", "unsupported_tool"].includes(code) ||
      (["unsupported_value", "unsupported_parameter"].includes(code) && ["tools", "tool_choice"].includes(error?.param))) {
    return "openai_tools_unsupported";
  }
  if (status === 408) return "openai_connection";
  return status >= 500 || status === undefined ? "openai_service" : "openai_request";
}

function claveOpenAI(entorno) {
  const clave = entorno.OPENAI_API_KEY?.trim();
  if (!clave) throw errorOpenAI("openai_key_missing");
  // Pi interpreta una credencial sin el prefijo de API como una sesión de ChatGPT.
  if (!/^sk-[a-zA-Z0-9_-]+$/.test(clave)) throw errorOpenAI("openai_key_invalid");
  return clave;
}

function cabecerasProyecto(entorno) {
  const headers = new Headers();
  if (entorno.OPENAI_ORG_ID) headers.set("OpenAI-Organization", entorno.OPENAI_ORG_ID);
  if (entorno.OPENAI_PROJECT_ID) headers.set("OpenAI-Project", entorno.OPENAI_PROJECT_ID);
  return headers;
}

export function ocultarClaveOpenAI(texto, entorno = process.env) {
  const clave = entorno.OPENAI_API_KEY?.trim();
  return clave ? texto.replaceAll(clave, "[credencial omitida]") : texto;
}

async function codigoHttp(response) {
  const cuerpo = await response.json().catch(() => null);
  return codigoOpenAI(response.status, cuerpo?.error);
}

async function solicitarOpenAI(ruta, { entorno = process.env, fetchFn = globalThis.fetch } = {}, payload) {
  const clave = claveOpenAI(entorno);
  const headers = cabecerasProyecto(entorno);
  headers.set("Authorization", `Bearer ${clave}`);
  if (payload) headers.set("Content-Type", "application/json");
  const response = await fetchFn(`${BASE}/${ruta}`, {
    headers, signal: AbortSignal.timeout(payload ? 30_000 : 10_000), redirect: "error",
    ...(payload ? { method: "POST", body: JSON.stringify(payload) } : {}),
  }).catch(() => { throw errorOpenAI("openai_connection"); });
  if (!response.ok) throw errorOpenAI(await codigoHttp(response));
  return response.json().catch(() => null);
}

export async function listarModelosOpenAI(opciones) {
  const listado = await solicitarOpenAI("models", opciones);
  if (!Array.isArray(listado?.data)) throw errorOpenAI("openai_service");
  const fecha = (modelo) => Number.isSafeInteger(modelo.created) ? modelo.created : 0;
  const disponibles = listado.data.filter((modelo) => modeloValido(modelo?.id))
    .sort((a, b) => fecha(b) - fecha(a));
  return [...new Set(disponibles.map(({ id }) => id))];
}

export async function validarModeloOpenAI(id, opciones) {
  if (!id) throw errorOpenAI("openai_model_missing");
  if (!modeloValido(id)) throw errorOpenAI("openai_model_incompatible");
  if (!(await listarModelosOpenAI(opciones)).includes(id)) throw errorOpenAI("openai_model_access");
  // El catálogo de la cuenta puede incorporar un modelo antes que el catálogo de Pi.
  const modelo = modelosPi.get(id) ?? {
    id, name: id, provider: "openai", api: "openai-responses", baseUrl: BASE,
    input: ["text"], reasoning: false, contextWindow: 0, maxTokens: 2048,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  return { modelo, clave: claveOpenAI(opciones?.entorno ?? process.env) };
}

const esConteo = (valor) => Number.isSafeInteger(valor) && valor >= 0;
const modeloValido = (modelo) => typeof modelo === "string" && /^[^\s\x00-\x1f\x7f-\x9f]{1,256}$/.test(modelo)
  && !modelo.startsWith("sk-");

function tokensReportados(uso) {
  if (!uso || ![uso.input_tokens, uso.output_tokens, uso.total_tokens].every(esConteo)) return null;
  return { entrada: uso.input_tokens, salida: uso.output_tokens, total: uso.total_tokens };
}

export async function comprobarHerramientasOpenAI(modelId, opciones) {
  await validarModeloOpenAI(modelId, opciones);
  const name = "observar_entorno";
  const respuesta = await solicitarOpenAI("responses", opciones, {
    model: modelId, input: "Devuelve la llamada sin argumentos de comprobación de conectividad.",
    tools: [{ type: "function", name, strict: true, parameters: { type: "object", properties: {}, additionalProperties: false } }],
    tool_choice: { type: "function", name }, max_output_tokens: 512, store: false,
  });
  if (respuesta?.error) throw errorOpenAI(codigoOpenAI(undefined, respuesta.error));
  const llamada = Array.isArray(respuesta?.output) && respuesta.output.find((item) =>
    item?.type === "function_call" && item.name === name && typeof item.arguments === "string");
  let argumentos;
  try {
    if (llamada) argumentos = JSON.parse(llamada.arguments);
  } catch {
    // La prueba verifica el protocolo de herramientas y no ejecuta la llamada.
  }
  if (respuesta?.status !== "completed" || !argumentos || Array.isArray(argumentos)
      || typeof argumentos !== "object" || Object.keys(argumentos).length) {
    throw errorOpenAI("openai_probe_tool");
  }
  return { modelId, modeloDevuelto: modeloValido(respuesta.model) ? respuesta.model : null, herramienta: name,
    tokens: tokensReportados(respuesta.usage) };
}

export function seguirOpenAI(fetchFn = globalThis.fetch, entorno = process.env, modelo) {
  const admiteResumen = modelo?.reasoning && modelo.api === "openai-responses" &&
    RESUMEN_DOCUMENTADO.test(modelo.id) && modelo.thinkingLevelMap?.low;
  const resumenes = new Map();
  function guardarResumen(indice, item) {
    if (item?.type !== "reasoning" || !Array.isArray(item.summary) || !item.summary.length) return;
    resumenes.set(indice, new Map(item.summary.map((parte, n) => [n,
      parte?.type === "summary_text" && typeof parte.text === "string" ? parte.text : ""])));
  }
  const solicitudes = [];
  const cabeceras = cabecerasProyecto(entorno);
  let actual;
  return {
    nuevaSolicitud() {
      resumenes.clear();
      actual = {};
      solicitudes.push(actual);
    },
    resumenOficial() {
      return [...resumenes.entries()].sort(([a], [b]) => a - b)
        .flatMap(([, partes]) => [...partes.entries()].sort(([a], [b]) => a - b).map(([, texto]) => texto))
        .filter(Boolean).join("\n\n");
    },
    errorActual() {
      // Si hubo HTTP exitoso pero el stream cayó antes de terminar, faltó el cierre de Responses.
      return actual?.error ?? (actual?.streamAbierto && !actual.terminal ? "openai_connection" : "openai_service");
    },
    resumen() {
      const modelosDevueltos = [...new Set(solicitudes.flatMap(({ modelo }) => modelo ? [modelo] : []))];
      const mediciones = solicitudes.flatMap(({ tokens }) => tokens ? [tokens] : []);
      const tokens = mediciones.length ? { entrada: 0, salida: 0, total: 0 } : null;
      for (const medicion of mediciones) {
        tokens.entrada += medicion.entrada;
        tokens.salida += medicion.salida;
        tokens.total += medicion.total;
      }
      return { modelosDevueltos, tokens, solicitudes: solicitudes.length, respuestasConUso: mediciones.length,
        estado: !tokens ? "no_disponible" : mediciones.length === solicitudes.length ? "completo" : "parcial" };
    },
    hooks: {
      onPayload(payload) {
        const limpio = JSON.parse(ocultarClaveOpenAI(JSON.stringify(payload), entorno));
        if (!modelosPi.has(limpio.model)) {
          // Los modelos que razonan necesitan poder continuar sin estado remoto.
          limpio.include = [...new Set([...(limpio.include ?? []), "reasoning.encrypted_content"])];
        }
        if (admiteResumen) {
          const esfuerzo = limpio.reasoning?.effort;
          limpio.reasoning = { ...limpio.reasoning, effort: !esfuerzo || esfuerzo === "none" ? admiteResumen : esfuerzo,
            summary: "auto" };
          limpio.include = [...new Set([...(limpio.include ?? []), "reasoning.encrypted_content"])];
        }
        return limpio;
      },
      async fetch(input, init) {
        const solicitud = actual;
        const url = input instanceof Request ? input.url : String(input);
        if (url !== `${BASE}/responses`) throw errorOpenAI("openai_connection");
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        // El catálogo y Responses deben usar el mismo proyecto, incluso con variables ambientales del SDK.
        headers.delete("OpenAI-Organization");
        headers.delete("OpenAI-Project");
        for (const [nombre, valor] of cabeceras) headers.set(nombre, valor);
        const response = await fetchFn(input, { ...init, headers, redirect: "error" }).catch(() => {
          solicitud.error = "openai_connection";
          throw errorOpenAI(solicitud.error);
        });
        if (!response.ok) solicitud.error = await codigoHttp(response.clone());
        else solicitud.streamAbierto = true;
        return response;
      },
      onProviderStreamEvent(evento) {
        const respuesta = evento.response;
        if (admiteResumen && Number.isInteger(evento.output_index)) {
          if (evento.type === "response.reasoning_summary_text.delta" && typeof evento.delta === "string") {
            const partes = resumenes.get(evento.output_index) ?? new Map();
            const indice = evento.summary_index ?? 0;
            partes.set(indice, (partes.get(indice) ?? "") + evento.delta);
            resumenes.set(evento.output_index, partes);
          } else if (evento.type === "response.output_item.done") {
            guardarResumen(evento.output_index, evento.item);
          }
        }
        if (admiteResumen && ["response.completed", "response.incomplete"].includes(evento.type)) {
          respuesta?.output?.forEach((item, indice) => guardarResumen(indice, item));
        }
        if (modeloValido(respuesta?.model)) {
          actual.modelo = respuesta.model;
        }
        if (evento.type === "error" || evento.type === "response.failed") {
          actual.error = codigoOpenAI(undefined, respuesta?.error ?? evento);
        }
        if (["response.completed", "response.incomplete", "response.failed"].includes(evento.type)) {
          actual.terminal = true;
          actual.tokens ??= tokensReportados(respuesta?.usage);
        }
      },
    },
  };
}
