import { readFile } from "node:fs/promises";

const BSSID = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
const ID_EVIDENCIA = /^[0-9]{13}-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const sinControles = (valor) => !/[\x00-\x1f\x7f-\x9f]/.test(valor);
const normalizarBssid = (bssid) => typeof bssid === "string" && bssid.length === 17 && BSSID.test(bssid)
  ? bssid.toUpperCase() : undefined;
const esIdEvidencia = (id) => typeof id === "string" && id.length === 50 && ID_EVIDENCIA.test(id);
const texto = (maxLength) => ({ type: "string", minLength: 1, maxLength });
const objeto = (properties) => ({ type: "object", properties,
  required: Object.keys(properties), additionalProperties: false });

export const HERRAMIENTAS = Object.freeze({
  observar_entorno: objeto({}),
  inspeccionar_postura: objeto({ bssid: { type: "string", pattern: BSSID.source.replaceAll("a-f", "a-fA-F") } }),
  registrar_hallazgo: objeto({
    bssid: { type: "string", pattern: BSSID.source.replaceAll("a-f", "a-fA-F") },
    categoria: texto(64),
    detalle: texto(1000),
    evidenceId: { type: "string", pattern: ID_EVIDENCIA.source },
  }),
});

export async function cargarObjetivosMock(scope) {
  const fixture = JSON.parse(await readFile(new URL("./ejemplos/escenario-wifi-mock.json", import.meta.url), "utf8"));
  const objetivos = new Map();
  for (const { bssid, ssid, canal } of fixture.aps) {
    if (!normalizarBssid(bssid) || bssid !== bssid.toUpperCase() || typeof ssid !== "string"
        || Buffer.byteLength(ssid) < 1 || Buffer.byteLength(ssid) > 32 || !sinControles(ssid)
        || !Number.isInteger(canal) || canal < 1 || canal > 233) {
      throw new Error("El fixture mock contiene un objetivo inválido.");
    }
    if ((!scope.allowedBssids.length || scope.allowedBssids.includes(bssid))
        && (!scope.allowedSsids.length || scope.allowedSsids.includes(ssid))
        && (!scope.allowedChannels.length || scope.allowedChannels.includes(canal))) {
      objetivos.set(bssid, Object.freeze({ bssid, ssid, canal }));
    }
  }
  return objetivos;
}

export function parametrosAuditables(name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  if (name !== "inspeccionar_postura" && name !== "registrar_hallazgo") return {};
  const bssid = Object.hasOwn(args, "bssid") ? normalizarBssid(args.bssid) : undefined;
  const parametros = bssid ? { bssid } : {};
  if (name === "registrar_hallazgo") {
    if (Object.hasOwn(args, "evidenceId") && esIdEvidencia(args.evidenceId)) parametros.evidenceId = args.evidenceId;
    for (const clave of ["categoria", "detalle"]) {
      if (Object.hasOwn(args, clave)) parametros[clave] = { omitido: true };
    }
  }
  return parametros;
}

const denegar = (code) => ({ ok: false, code });

export function authorize({ name, args }, contexto, { status, intento, vigente }) {
  if (status !== "running") return denegar("session_inactive");
  if (intento < 1 || intento > contexto.snapshot.scope.maxIterations) return denegar("tool_limit");
  if (contexto.snapshot.adapter.id !== "mock" || contexto.snapshot.adapter.mode !== "mock") return denegar("adapter_denied");
  if (!vigente) return denegar("scope_changed");
  if (!Object.hasOwn(HERRAMIENTAS, name)) return denegar("unknown_tool");

  const claves = HERRAMIENTAS[name].required;
  if (!args || typeof args !== "object" || Array.isArray(args)
      || Object.keys(args).length !== claves.length || !claves.every((clave) => Object.hasOwn(args, clave))
      || !claves.every((clave) => typeof args[clave] === "string")) return denegar("invalid_arguments");
  if (name === "observar_entorno") return { ok: true, params: {} };
  const bssid = normalizarBssid(args.bssid);
  if (!bssid) return denegar("invalid_arguments");
  if (!contexto.objetivos.has(bssid)) return denegar("target_denied");
  if (name === "inspeccionar_postura") return { ok: true, params: { bssid } };

  const { categoria, detalle, evidenceId } = args;
  const textoValido = (valor, limite) => valor.trim() && [...valor].length <= limite && sinControles(valor);
  if (!textoValido(categoria, 64) || !textoValido(detalle, 1000) || !esIdEvidencia(evidenceId)) return denegar("invalid_arguments");
  const evidencia = contexto.evidencias.get(evidenceId);
  if (!evidencia || !evidencia.bssids.includes(bssid)) return denegar("evidence_denied");
  return { ok: true, params: { bssid, categoria: categoria.trim(), detalle: detalle.trim(), evidenceId } };
}
