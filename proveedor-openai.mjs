import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

const BASE = "https://api.openai.com/v1";
const MODELOS_VERIFICADOS = ["gpt-4.1-mini", "gpt-5-mini", "gpt-5.4-mini"];
const modelosPi = new Map(openaiProvider().getModels()
  .filter(({ provider, api, baseUrl }) => provider === "openai" && api === "openai-responses" && baseUrl === BASE)
  .map((modelo) => [modelo.id, modelo]));
const CUOTA = new Set(["insufficient_quota", "billing_hard_limit_reached", "credit_balance_exhausted",
  "organization_spend_limit_exceeded", "project_spend_limit_exceeded", "organization_usage_limit_exceeded"]);

export const MENSAJES_OPENAI = {
  openai_key_missing: "OpenAI requiere OPENAI_API_KEY en el entorno de Harwiff.",
  openai_key_invalid: "OpenAI rechazó la autenticación. Revisa OPENAI_API_KEY y los permisos de la clave.",
  openai_model_missing: "Selecciona un modelo con /config modelos y /config modelo <model-id>.",
  openai_model_incompatible: "El modelo no está en el catálogo compatible de Harwiff. Consulta /config modelos.",
  openai_model_access: "OpenAI no autoriza el acceso al modelo o a este recurso. Revisa el proyecto y /config modelos.",
  openai_quota: "OpenAI indica que se agotó la cuota, el crédito o el límite de gasto del proyecto.",
  openai_rate_limit: "Se alcanzó el límite de solicitudes o tokens por minuto de OpenAI. Espera antes de reintentar.",
  openai_connection: "No se pudo completar la conexión con la API oficial de OpenAI.",
  openai_service: "El servicio de OpenAI interrumpió la operación. Intenta de nuevo más tarde.",
  openai_request: "OpenAI rechazó la solicitud. Revisa el modelo y su compatibilidad con Responses.",
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

export async function listarModelosOpenAI({ entorno = process.env, fetchFn = globalThis.fetch } = {}) {
  const clave = claveOpenAI(entorno);
  const headers = cabecerasProyecto(entorno);
  headers.set("Authorization", `Bearer ${clave}`);
  const response = await fetchFn(`${BASE}/models`, {
    headers, signal: AbortSignal.timeout(10_000), redirect: "error",
  }).catch(() => { throw errorOpenAI("openai_connection"); });
  if (!response.ok) throw errorOpenAI(await codigoHttp(response));
  const listado = await response.json().catch(() => null);
  if (!Array.isArray(listado?.data)) throw errorOpenAI("openai_service");
  const disponibles = new Set(listado.data.map((modelo) => modelo?.id));
  return MODELOS_VERIFICADOS.filter((id) => modelosPi.has(id) && disponibles.has(id));
}

export async function validarModeloOpenAI(id, opciones) {
  if (!id) throw errorOpenAI("openai_model_missing");
  if (!MODELOS_VERIFICADOS.includes(id) || !modelosPi.has(id)) throw errorOpenAI("openai_model_incompatible");
  if (!(await listarModelosOpenAI(opciones)).includes(id)) throw errorOpenAI("openai_model_access");
  return { modelo: modelosPi.get(id), clave: claveOpenAI(opciones?.entorno ?? process.env) };
}

const esConteo = (valor) => Number.isSafeInteger(valor) && valor >= 0;

export function seguirOpenAI(fetchFn = globalThis.fetch, entorno = process.env) {
  const solicitudes = [];
  const cabeceras = cabecerasProyecto(entorno);
  let actual;
  return {
    nuevaSolicitud() {
      actual = {};
      solicitudes.push(actual);
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
        return JSON.parse(ocultarClaveOpenAI(JSON.stringify(payload), entorno));
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
        if (typeof respuesta?.model === "string" && /^gpt-[a-z0-9.-]{1,96}$/.test(respuesta.model)) {
          actual.modelo = respuesta.model;
        }
        if (evento.type === "error" || evento.type === "response.failed") {
          actual.error = codigoOpenAI(undefined, respuesta?.error ?? evento);
        }
        if (["response.completed", "response.incomplete", "response.failed"].includes(evento.type)) {
          actual.terminal = true;
          const uso = respuesta?.usage;
          if (uso && [uso.input_tokens, uso.output_tokens, uso.total_tokens].every(esConteo)) {
            actual.tokens ??= { entrada: uso.input_tokens, salida: uso.output_tokens, total: uso.total_tokens };
          }
        }
      },
    },
  };
}
