import { execFile } from "node:child_process";
import { ocultarClaveOpenAI } from "./proveedor-openai.mjs";

const ATRIBUTOS = ["application", "harwiff", "provider", "openai"];

function ejecutarSecretTool(operacion, entrada, entorno) {
  if (!entorno.DBUS_SESSION_BUS_ADDRESS) return Promise.resolve({ estado: "no_disponible" });
  const { OPENAI_API_KEY, FOUNDRY_API_KEY, OPENSANDBOX_API_KEY, ...env } = entorno;
  const args = operacion === "store" ? ["store", "--label=Harwiff OpenAI API", ...ATRIBUTOS] : [operacion, ...ATRIBUTOS];
  return new Promise((resolve) => {
    const hijo = execFile("secret-tool", args, { env, timeout: 10_000, maxBuffer: 8192 }, (error, salida, stderr) => {
      if (!error) resolve({ estado: "ok", salida: salida.trim() });
      else if (error.code === 1 && !stderr.trim() && operacion !== "store") resolve({ estado: "ausente" });
      else resolve({ estado: "no_disponible" });
    });
    hijo.stdin?.on("error", () => {});
    hijo.stdin?.end(entrada);
  });
}

export function crearCredencialesOpenAI({ entorno = process.env, ejecutar = ejecutarSecretTool } = {}) {
  let memoria;
  let claveVista;

  function conClave(clave) {
    return { ...entorno, OPENAI_API_KEY: clave };
  }

  function contexto(clave, fuente) {
    claveVista = clave;
    return { entorno: conClave(clave), fuente };
  }

  return {
    conClave,
    ocultar(texto) {
      return ocultarClaveOpenAI(ocultarClaveOpenAI(texto, entorno), { OPENAI_API_KEY: claveVista });
    },
    async resolver() {
      if (memoria) return contexto(memoria.clave, memoria.fuente);
      const externa = entorno.OPENAI_API_KEY?.trim();
      if (externa) return contexto(externa, "OPENAI_API_KEY");
      const resultado = await ejecutar("lookup", "", entorno);
      if (resultado.estado === "ok" && resultado.salida) return contexto(resultado.salida, "Secret Service");
      return contexto(undefined, null);
    },
    async guardar(clave) {
      const resultado = await ejecutar("store", clave, entorno);
      const fuente = resultado.estado === "ok" ? "Secret Service" : "memoria de Harwiff";
      memoria = { clave, fuente };
      claveVista = clave;
      return fuente;
    },
    async desvincular() {
      memoria = undefined;
      claveVista = undefined;
      return (await ejecutar("clear", "", entorno)).estado;
    },
  };
}
