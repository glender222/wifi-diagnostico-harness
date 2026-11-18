import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const python = process.env.WIFI_PYTHON || "python3";
const fuente = (script) => fileURLToPath(new URL(script, import.meta.url));
const { FOUNDRY_API_KEY, OPENSANDBOX_API_KEY, ...env } = process.env;

export function ejecutar(script, args, { entrada = "", signal, tiempo = 480_000 } = {}) {
  return new Promise((ok, fail) => {
    const proceso = execFile(python, ["-B", fuente(script), ...args],
      { env, timeout: tiempo, signal, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) fail(new Error(stderr.trim().replace(/^Error: /, "") || "No se pudo completar la operación local."));
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

export async function conBloqueoProyecto(raiz, tarea, mensajeOcupado = "Otra consola está actualizando el alcance. Vuelve a intentar.") {
  const directorio = await open(raiz, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await new Promise((ok, fail) => {
      const proceso = spawn(python, ["-B", fuente("entorno.py"), "bloquear-config"], {
        env, stdio: ["ignore", "ignore", "ignore", directorio.fd], signal: AbortSignal.timeout(5_000),
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
