import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const python = process.env.WIFI_PYTHON || "python3";
const fuente = (script) => fileURLToPath(new URL(script, import.meta.url));
const { FOUNDRY_API_KEY, OPENAI_API_KEY, OPENSANDBOX_API_KEY, ...env } = process.env;
const envLectura = Object.fromEntries(["PATH", "LANG", "LC_ALL", "DBUS_SYSTEM_BUS_ADDRESS"]
  .filter(clave => process.env[clave] !== undefined).map(clave => [clave, process.env[clave]]));

export function ejecutar(script, args, { entrada = "", signal, tiempo = 480_000, soloLectura = false } = {}) {
  return new Promise((ok, fail) => {
    const proceso = execFile(python, ["-B", fuente(script), ...args],
      { env: soloLectura ? envLectura : env, timeout: tiempo, signal, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) fail(new Error((!soloLectura && stderr.trim().replace(/^Error: /, "")) || "No se pudo completar la operación local."));
        else ok(stdout.trim());
      });
    proceso.stdin.on("error", () => {});
    proceso.stdin.end(entrada);
  });
}

export async function entorno(operacion, datos, opciones) {
  const entrada = JSON.stringify(datos);
  const salida = await ejecutar("entorno.py", [operacion], { entrada, tiempo: 25_000, ...opciones });
  return JSON.parse(salida);
}

export function crearBrokerLocal(tipo) {
  if (tipo !== "host_readonly" && tipo !== "fixture") throw new Error("Proveedor local desconocido.");
  const host = tipo === "host_readonly";
  const operacion = host ? "broker-lectura" : "broker-mock";
  return {
    async execute(solicitud, signal, tiempo = 5000) {
      const resultado = await entorno(operacion, solicitud, {signal, tiempo, soloLectura: true});
      if (host) return resultado;
      return {version: 1, origin: tipo, status: resultado.ok ? "ok" : "denied", resultado};
    },
  };
}

export async function conBloqueoProyecto(raiz, tarea, mensajeOcupado = "Otra consola está actualizando el alcance. Vuelve a intentar.") {
  const directorio = await open(raiz, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await new Promise((ok, fail) => {
      const proceso = spawn(python, ["-B", fuente("entorno.py"), "bloquear-config"], {
        env: envLectura, stdio: ["ignore", "ignore", "ignore", directorio.fd], signal: AbortSignal.timeout(5_000),
      });
      proceso.once("error", () => fail(new Error("No se pudo reservar el estado Wi-Fi del proyecto.")));
      proceso.once("exit", (codigo) => {
        if (codigo === 0) ok();
        else if (codigo === 2) fail(Object.assign(new Error(mensajeOcupado), { code: "LOCK_BUSY" }));
        else fail(new Error("No se pudo reservar el directorio de Harwiff."));
      });
    });
    return await tarea();
  } finally {
    await directorio.close();
  }
}

const valores = (lista, valor) => lista.includes(valor) ? valor : "unknown";
const fuentesInventario = ["sysfs", "sysfs/net", "sysfs/ieee80211", "sysfs/rfkill", "nmcli", "iw_dev", "iw_phy", "iw_reg", "ip-4", "ip-6", "ethtool",
  "nl80211_interface", "nl80211_wiphy", "nl80211_reg", "ethtool_drvinfo"];
const codigosInventario = ["source_unavailable", "permission_denied", "probe_timeout", "parse_unsupported", "adapter_disconnected", "ambiguous_interface",
  "snapshot_incomplete", "attribute_missing", "unsupported_attribute"];
const avisosInventario = (lista) => lista
  .filter(({ code, source }) => codigosInventario.includes(code) && fuentesInventario.includes(source))
  .slice(0, 8).map(({ code, source }) => ({ code, source }));

export function depurarInventario(perfil) {
  if (perfil?.schema !== "harwiff-adapter-inventory/v1" || !Array.isArray(perfil.devices)) {
    throw new Error("El inventario local tiene un formato desconocido.");
  }
  const maxDispositivos = 4;
  const maxRadios = 4;
  const limitados = perfil.devices.slice(0, maxDispositivos);
  return {
    ok: true, origen: "host_readonly", adaptadorSesion: "mock",
    inventarioEstado: valores(["complete", "partial", "unavailable"], perfil.status),
    truncado: perfil.devices.length > maxDispositivos || limitados.some(({ phys }) => phys.length > maxRadios)
      || perfil.warnings.length > 8 || limitados.some(({ phys }) => phys.some(({ probe }) => probe.warnings.length > 8)),
    avisos: avisosInventario(perfil.warnings),
    dispositivos: limitados.map(({ bus, phys }, indice) => ({
      alias: "dispositivo-" + (indice + 1),
      bus: valores(["usb", "pci", "sdio", "platform", "virtual"], bus),
      radios: phys.slice(0, maxRadios).map(({ interfaces, capabilities, connectivity, probe }, numero) => ({
        alias: "radio-" + (numero + 1),
        interfaces: interfaces.length,
        conectividad: valores(["critical", "noncritical", "potentially_critical"], connectivity.criticality),
        monitorAnunciado: valores(["supported", "unsupported"], capabilities.monitor.declared),
        concurrenciaAnunciada: valores(["supported", "unsupported"], capabilities.concurrency.declared),
        verificacionOperativa: "not_tested",
        avisos: avisosInventario(probe.warnings),
      })),
    })),
  };
}
