import { readFile } from "node:fs/promises";

const BSSID = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
const ID_EVIDENCIA = /^[0-9]{13}-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
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
  return new Set(fixture.aps.filter(({ bssid, ssid, canal }) =>
    (!scope.allowedBssids.length || scope.allowedBssids.includes(bssid))
    && (!scope.allowedSsids.length || scope.allowedSsids.includes(ssid))
    && (!scope.allowedChannels.length || scope.allowedChannels.includes(canal))).map(({ bssid }) => bssid));
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
  if (!BSSID.test(args.bssid) || args.bssid.length !== 17) return denegar("invalid_arguments");
  const bssid = args.bssid.toUpperCase();
  if (!contexto.objetivos.has(bssid)) return denegar("target_denied");
  if (name === "inspeccionar_postura") return { ok: true, params: { bssid } };

  const { categoria, detalle, evidenceId } = args;
  const textoValido = (valor, limite) => valor.trim() && [...valor].length <= limite && !/[\x00-\x1f\x7f-\x9f]/.test(valor);
  if (!textoValido(categoria, 64) || !textoValido(detalle, 1000) || evidenceId.length !== 50
      || !ID_EVIDENCIA.test(evidenceId)) return denegar("invalid_arguments");
  const evidencia = contexto.evidencias.get(evidenceId);
  if (!evidencia || !evidencia.bssids.includes(bssid)) return denegar("evidence_denied");
  return { ok: true, params: { bssid, categoria: categoria.trim(), detalle: detalle.trim(), evidenceId } };
}
