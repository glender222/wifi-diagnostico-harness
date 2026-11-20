import { createProvider } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { ejecutarPi, modeloFoundry } from "./bucle.mjs";
import { validarModeloOpenAI } from "./proveedor-openai.mjs";

// Opciones comprobables en los adaptadores Pi que soporta este recorrido.
const limitesSalida = {
  "openai-responses": ["max_output_tokens"],
  "openai-completions": ["max_completion_tokens", "max_tokens"],
  "anthropic-messages": ["max_tokens"],
};

export async function resolverModeloInspeccion(config, env = process.env) {
  const perfil = config.llm?.inspeccion ?? {};
  const proveedor = env.HARWIFF_LLM_PROVIDER ?? perfil.provider ?? config.llm?.proveedor
    ?? (config.foundry || env.FOUNDRY_HOST || config.cliente === "azure-foundry" ? "azure-foundry" : null);
  const id = env.HARWIFF_LLM_MODEL ?? perfil.model ?? (proveedor === "openai" ? config.llm?.openaiModelId : undefined);
  if (!proveedor) throw new Error("Configura un proveedor y modelo para la inspección.");
  const modelos = builtinModels();
  let modelo;
  let opciones = { env };
  if (proveedor === "azure-foundry") {
    const seleccion = id ? {...config, foundry: {...config.foundry, deployment: id}} : config;
    const encontrado = modeloFoundry(seleccion, {...env, FOUNDRY_API_KEY: env.FOUNDRY_API_KEY ?? env.AZURE_OPENAI_API_KEY});
    modelo = encontrado.modelo;
    const api = await import("@earendil-works/pi-ai/api/openai-completions");
    modelos.setProvider(createProvider({
      id: modelo.provider, name: "Azure Foundry", models: [modelo], api,
      auth: { apiKey: modelos.getProvider(modelo.provider).auth.apiKey },
    }));
    opciones = {...opciones, apiKey: encontrado.clave};
  } else {
    modelo = modelos.getModel(proveedor, id);
    if (!modelo && proveedor === "openai" && id) {
      const encontrado = await validarModeloOpenAI(id, {entorno: env});
      modelo = encontrado.modelo;
      opciones = {...opciones, apiKey: encontrado.clave};
    }
  }
  if (proveedor === "openai") {
    opciones.headers = Object.fromEntries([["OpenAI-Organization", env.OPENAI_ORG_ID], ["OpenAI-Project", env.OPENAI_PROJECT_ID]]
      .filter(([, valor]) => valor));
  }
  if (!modelo?.input.includes("text") || !Object.hasOwn(limitesSalida, modelo.api) ||
      !Number.isSafeInteger(modelo.maxTokens) || modelo.maxTokens <= 0) {
    throw new Error("El modelo o su adaptador Pi no está disponible para inspección.");
  }
  const declarado = perfil.contextWindow;
  if (declarado !== undefined && (!Number.isSafeInteger(declarado) || declarado <= 0)) {
    throw new Error("La ventana de contexto configurada debe ser un entero positivo.");
  }
  const maxContext = modelo.contextWindow > 0 && declarado !== undefined
    ? Math.min(modelo.contextWindow, declarado) : declarado ?? modelo.contextWindow;
  if (!Number.isSafeInteger(maxContext) || maxContext <= 0) {
    throw new Error("Define una ventana de contexto conocida en llm.inspeccion.contextWindow.");
  }
  return {
    modelo, maxContext, maxOutput: modelo.maxTokens,
    streamFn: (model, context, options) => modelos.streamSimple(model, context, {...options, ...opciones}),
  };
}

export function streamAcotado(conexion, presupuesto, control) {
  return (model, context, opciones) => conexion.streamFn(model, context, {
    ...opciones,
    maxTokens: Math.min(presupuesto.salida, conexion.maxOutput),
    reasoning: "off",
    ...(control.final ? {toolChoice: "none"} : {}),
    async onPayload(payload) {
      opciones.signal?.throwIfAborted();
      const serializado = JSON.stringify(payload);
      const salida = Math.min(presupuesto.salida, conexion.maxOutput);
      const enviado = limitesSalida[model.api]?.map((campo) => payload?.[campo]).find(Number.isInteger);
      const estimado = estimateTextTokens(serializado);
      const longitud = Buffer.byteLength(serializado);
      if (!Number.isInteger(enviado) || enviado <= 0 || enviado > salida ||
          longitud > presupuesto.bytes ||
          estimado + enviado > conexion.maxContext ||
          control.total + estimado + enviado > presupuesto.tokens) {
        control.limitado = true;
        throw new Error("Límite del modelo o del turno alcanzado.");
      }
      await control.antesDeEnviar?.();
      control.estimado = estimado;
      control.bytesEnviados = (control.bytesEnviados ?? 0) + longitud;
      control.envios++;
      return payload;
    },
  });
}

export async function probarModeloInspeccion(conexion, signal) {
  const control = {total: 0, envios: 0, final: false};
  const presupuesto = {salida: 512, bytes: 8192, tokens: 6000};
  const testigo = "harwiff-confirmado";
  let llamadas = 0;
  let estadoHttp;
  const mensajes = await ejecutarPi({
    ...conexion, signal, emitir: () => {},
    prompts: [{role: "user", content: 'Llama una vez a comprobar y después devuelve solo JSON con la clave "resultado" y el valor recibido.', timestamp: Date.now()}],
    herramientas: [{
      name: "comprobar", label: "Comprobar", description: "Devuelve un dato de prueba.",
      parameters: {type: "object", properties: {}, required: [], additionalProperties: false},
      execute(_id, args) {
        signal?.throwIfAborted();
        if (++llamadas !== 1 || Object.keys(args).length) return {content: [{type: "text", text: "inválido"}]};
        return {content: [{type: "text", text: testigo}]};
      },
    }],
    streamFn: streamAcotado(conexion, presupuesto, control),
    hooks: {
      toolExecution: "sequential", maxRetries: 0,
      onResponse({status}) { estadoHttp = status; },
      prepareRequest() {
        if (control.envios >= 2) throw new Error("La prueba de compatibilidad superó dos solicitudes.");
      },
    },
  });
  const ultimo = mensajes.findLast(mensaje => mensaje.role === "assistant");
  let valor;
  try {
    valor = JSON.parse(ultimo?.content.filter(item => item.type === "text").map(item => item.text).join(""));
  } catch { /* La prueba exige una respuesta JSON. */ }
  if (llamadas !== 1 || control.envios !== 2 || ultimo?.stopReason !== "stop" ||
      Object.keys(valor ?? {}).length !== 1 || valor.resultado !== testigo) {
    const detalle = [401, 403].includes(estadoHttp) ? " La autenticación o el acceso fue rechazado."
      : estadoHttp >= 400 ? " El proveedor devolvió HTTP " + estadoHttp + "." : "";
    throw new Error("El modelo no completó la prueba de herramienta y continuación." + detalle);
  }
  return ultimo.model;
}
