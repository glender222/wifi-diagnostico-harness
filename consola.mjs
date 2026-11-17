import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { DEPLOYMENT_AZURE, DOMINIO_AZURE, guardarJson, leerTurnos, modeloFoundry, responder } from "./bucle.mjs";

const clientes = ["chatgpt", "opencode", "azure-foundry"];
const python = process.env.WIFI_PYTHON || "python3";
const instalador = fileURLToPath(new URL("./app.py", import.meta.url));
const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);

function ejecutar(script, args, entrada = "") {
  return new Promise((ok, fail) => {
    const proceso = execFile(python, ["-B", script, ...args], { timeout: 240_000 }, (error, stdout, stderr) => {
      if (error) fail(new Error(stderr.trim() || error.message));
      else ok(stdout.trim());
    });
    proceso.stdin.on("error", () => {}); // El proceso puede terminar antes de leer la entrada.
    proceso.stdin.end(entrada);
  });
}

function textoSeguro(texto) {
  return texto.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

function mostrar(texto) {
  console.log(textoSeguro(String(texto)));
}

async function consola() {
  const comandos = {
    "/ayuda": ["", "Muestra los comandos", ayuda],
    "/config": ["[local|opensandbox|dominio deployment]", "Consulta o guarda la configuración", configurar],
    "/sesiones": ["", "Lista las sesiones", async () => mostrar(await app("sesiones") || "Todavía no hay sesiones.")],
    "/nueva": ["<id> <objetivo>", "Crea y abre una sesión", nueva],
    "/abrir": ["<id>", "Retoma una sesión", abrir],
    "/contexto": ["", "Muestra reglas, notas, informes y conversación de la sesión activa", exportar],
    "/guardar": ["<nota>", "Guarda el avance en la sesión activa", guardar],
    "/diagnostico": ["[demo]", "Guarda un diagnóstico actual o sintético", diagnostico],
    "/salir": ["", "Cierra la aplicación", () => { salir = true; }],
  };

  const consola = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: tty,
    completer: (texto) => [Object.keys(comandos).filter((nombre) => nombre.startsWith(texto)), texto],
  });
  const lineas = consola[Symbol.asyncIterator]();
  let salir = false;
  let controlador;
  let sesion;
  const cierre = new AbortController();
  consola.once("close", () => cierre.abort());
  const salida = (pregunta) => consola.question(pregunta, { signal: cierre.signal });
  consola.on("SIGINT", () => {
    if (controlador) controlador.abort();
    else consola.close();
  });

  let proyecto;
  let archivoConfig;
  let config;
  try {
    const entrada = process.argv[2] ?? (tty ? (await salida("Carpeta del proyecto [./proyecto-wifi] > ")).trim() : "");
    proyecto = resolve(entrada || "./proyecto-wifi");
    archivoConfig = join(proyecto, "harness.json");
    try {
      await access(archivoConfig);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const cliente = tty
        ? (await salida("Cliente [chatgpt, opencode, azure-foundry] (chatgpt) > ")).trim() || "chatgpt"
        : "chatgpt";
      if (!clientes.includes(cliente)) throw new Error("Cliente desconocido.");
      mostrar(await ejecutar(instalador, ["iniciar", proyecto, "--cliente", cliente]));
    }
    config = JSON.parse(await readFile(archivoConfig, "utf8"));
    if (config?.esquema !== "wifi-proyecto/v1" || !clientes.includes(config.cliente)) {
      throw new Error("La carpeta no contiene un proyecto Wi-Fi válido.");
    }

    mostrar(`Wi-Fi Harness · ${config.cliente} · ${proyecto}`);
    mostrar("Escribe /ayuda para ver los comandos. Usa Tab para completarlos.");
    prompt();
    for await (const entrada of lineas) {
      const texto = entrada.trim();
      try {
        if (texto.startsWith("/")) {
          const [nombre] = texto.split(/\s+/, 1);
          const comando = comandos[nombre];
          if (!comando) throw new Error("Comando desconocido. Usa /ayuda.");
          await comando[2](texto.slice(nombre.length).trim());
        } else if (texto) {
          await conversar(texto);
        }
      } catch (error) {
        mostrar("Error: " + error.message);
      }
      if (salir) break;
      prompt();
    }
  } catch (error) {
    if (error.code !== "ABORT_ERR") throw error;
  } finally {
    consola.close();
  }

  function app(...args) {
    return ejecutar(join(proyecto, "app.py"), args);
  }

  function activa() {
    if (!sesion) throw new Error("Abre una sesión con /abrir o crea una con /nueva.");
    return sesion;
  }

  function contexto() {
    return app("abrir", activa());
  }

  async function exportar() {
    mostrar(await contexto());
    const turnos = await leerTurnos(join(proyecto, "sesiones", activa()));
    for (const turno of turnos) {
      if (turno.estado !== "completo") {
        const consulta = turno.usuario?.content ?? turno.mensajes?.find((item) => item.role === "user")?.content;
        if (consulta) mostrar(`\nConsulta sin completar: ${consulta}`);
        continue;
      }
      for (const mensaje of turno.mensajes) {
        if (mensaje.role === "user") mostrar(`\nUsuario: ${mensaje.content}`);
        if (mensaje.role === "assistant") {
          const texto = mensaje.content.filter((parte) => parte.type === "text").map((parte) => parte.text).join("\n");
          if (texto) mostrar(`\nAsistente: ${texto}`);
        }
      }
    }
  }

  function prompt() {
    if (tty) {
      consola.setPrompt(`wifi${sesion ? "/" + sesion : ""} > `);
      consola.prompt();
    }
  }

  function ayuda() {
    for (const [nombre, [argumentos, descripcion]] of Object.entries(comandos)) {
      mostrar(`${nombre} ${argumentos} · ${descripcion}`);
    }
  }

  async function configurar(argumentos) {
    if (!argumentos) {
      mostrar(`Cliente: ${config.cliente} | Motor: ${config.motor ?? "local"}`);
      if (config.cliente === "azure-foundry") {
        mostrar(`Dominio: ${config.foundry?.host || process.env.FOUNDRY_HOST || "pendiente"}`);
        mostrar(`Deployment: ${config.foundry?.deployment || process.env.FOUNDRY_DEPLOYMENT || "pendiente"}`);
        mostrar(`Clave en el entorno: ${process.env.FOUNDRY_API_KEY ? "disponible" : "pendiente"}`);
      }
      return;
    }

    let cambio;
    if (argumentos === "local" || argumentos === "opensandbox") {
      cambio = { motor: argumentos };
    } else {
      const [host, deployment, extra] = argumentos.split(/\s+/);
      if (config.cliente !== "azure-foundry" || extra || !DOMINIO_AZURE.test(host) ||
          !deployment || !DEPLOYMENT_AZURE.test(deployment)) {
        throw new Error("Usa /config local, /config opensandbox o /config <dominio Azure> <deployment> en un proyecto Azure.");
      }
      cambio = { foundry: { host, deployment } };
    }
    const actualizada = { ...config, ...cambio };
    await guardarJson(archivoConfig, actualizada);
    config = actualizada;
    mostrar("Configuración guardada.");
  }

  async function nueva(argumentos) {
    const [id] = argumentos.split(/\s+/, 1);
    const objetivo = argumentos.slice(id.length).trim();
    if (!id || !objetivo) throw new Error("Usa /nueva <id> <objetivo>.");
    await app("nueva", id, "--objetivo", objetivo);
    await abrir(id);
  }

  async function abrir(id) {
    if (!id) throw new Error("Usa /abrir <id>.");
    await app("abrir", id);
    const carpeta = join(proyecto, "sesiones", id);
    const turnos = await leerTurnos(carpeta);
    sesion = id;
    mostrar(`Sesión activa: ${id} · ${turnos.length} turno(s) registrado(s)`);
    const ultima = turnos.findLast((turno) => turno.estado === "completo")?.mensajes.at(-1);
    if (ultima) mostrar(ultima.content.filter((parte) => parte.type === "text").map((parte) => parte.text).join("\n"));
    if (turnos.some((turno) => turno.estado !== "completo")) {
      mostrar("Hay turnos incompletos. Puedes volver a enviar la consulta.");
    }
  }

  async function guardar(nota) {
    if (!nota) throw new Error("Usa /guardar <nota>.");
    await ejecutar(join(proyecto, "app.py"), ["guardar", activa()], nota);
    mostrar("Nota añadida al registro.");
  }

  async function diagnostico(argumentos) {
    if (argumentos && argumentos !== "demo") throw new Error("Usa /diagnostico [demo].");
    const args = ["diagnosticar", activa(), "--motor", config.motor ?? "local"];
    if (argumentos === "demo") args.push("--demo");
    mostrar(await app(...args));
  }

  async function conversar(texto) {
    const id = activa();
    if (config.cliente !== "azure-foundry") {
      throw new Error(`Continúa la conversación en ${config.cliente}. /contexto muestra lo que puedes compartir con el chat.`);
    }
    const { modelo, clave } = modeloFoundry(config);
    controlador = new AbortController();
    let escribiendo = false;
    try {
      await responder({
        sesion: join(proyecto, "sesiones", id),
        texto, modelo, clave,
        leerContexto: contexto,
        signal: AbortSignal.any([controlador.signal, AbortSignal.timeout(120_000)]),
        emitir(evento) {
          if (evento.type === "message_update" && evento.assistantMessageEvent.type === "text_delta") {
            process.stdout.write(textoSeguro(evento.assistantMessageEvent.delta));
            escribiendo = true;
          }
          if (evento.type === "turn_end" && escribiendo) {
            process.stdout.write("\n");
            escribiendo = false;
          }
        },
      });
    } finally {
      if (escribiendo) process.stdout.write("\n");
      controlador = undefined;
    }
  }
}

try {
  await consola();
} catch (error) {
  console.error(textoSeguro("Error: " + error.message));
  process.exitCode = 1;
}
