#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, lstat, mkdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { DEPLOYMENT_AZURE, DOMINIO_AZURE, MODELO_DEMO, demo, guardarJson, leerTurnos, modeloFoundry, responder } from "./bucle.mjs";
import { ID_SESION, auditar, directorios, guardarInforme, idsAuditoria, informesAgente, leerAuditoria, leerJson } from "./proyecto.mjs";

const VERSION = "0.2.0";
const clientes = ["demo", "azure-foundry", "chatgpt", "opencode"];
const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const python = process.env.WIFI_PYTHON || "python3";
const fuente = (archivo) => fileURLToPath(new URL(archivo, import.meta.url));
const seguro = (texto) => String(texto).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
const comandos = {
  "/ayuda": "Comandos del entorno",
  "/adaptador": "Ver o elegir adaptador por número",
  "/diagnostico": "Ejecutar en OpenSandbox o usar /diagnostico demo",
  "/auditoria": "Listar ejecuciones o ver una por ID",
  "/config": "Ver configuración o fijar dominio y deployment de Foundry",
  "/sesiones": "Listar sesiones de trabajo del proyecto",
  "/nueva": "Crear una sesión de trabajo",
  "/abrir": "Abrir una sesión de trabajo",
  "/guardar": "Guardar una nota en la sesión de trabajo",
  "/contexto": "Ver notas e informes de la sesión de trabajo",
  "/volver": "Volver del agente al entorno",
  "/detener": "Cancelar el turno del agente activo",
  "/salir": "Cerrar Harwiff",
};

function ejecutar(script, args, { entrada = "", signal, tiempo = 480_000 } = {}) {
  const { FOUNDRY_API_KEY, OPENSANDBOX_API_KEY, ...env } = process.env;
  return new Promise((ok, fail) => {
    const proceso = execFile(python, ["-B", fuente(script), ...args],
      { env, timeout: tiempo, signal, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) fail(new Error(seguro(stderr.trim()) || "No se pudo completar la operación local."));
        else ok(stdout.trim());
      });
    proceso.stdin.on("error", () => {});
    proceso.stdin.end(entrada);
  });
}

async function existe(ruta) {
  try {
    await access(ruta);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function resumen(adaptadores) {
  return adaptadores.map(({ interfaz, tipo, activo }, index) =>
    `${index + 1}. ${interfaz} · ${tipo}${activo ? " · conexión activa" : ""}`).join("\n");
}

async function inventario() {
  return JSON.parse(await ejecutar("entorno.py", ["adaptadores"], { tiempo: 10_000 }));
}

function errorBloqueado(motivo) {
  return Object.assign(new Error(motivo), { decision: "denegado", publico: motivo });
}

async function configurarInicio(destino, salida, preguntar) {
  let carpeta = destino;
  if (!carpeta) carpeta = await existe("harness.json") ? "." :
    tty ? (await preguntar("Carpeta del proyecto [./proyecto-wifi] > ")).trim() : "";
  const proyecto = resolve(carpeta || "./proyecto-wifi");
  const ruta = join(proyecto, "harness.json");
  if (!await existe(ruta)) {
    const cliente = tty
      ? (await preguntar("Agente del proyecto [demo, azure-foundry] (demo) > ")).trim() || "demo" : "demo";
    if (!clientes.includes(cliente)) throw new Error("Cliente desconocido.");
    await ejecutar("app.py", ["iniciar", proyecto, "--cliente", cliente]);
  }
  const config = await leerJson(ruta);
  if (config?.esquema !== "wifi-proyecto/v1" || !clientes.includes(config.cliente)) {
    throw new Error("La carpeta no contiene un proyecto Wi-Fi válido.");
  }
  if (tty && !Object.hasOwn(config, "adaptador")) {
    try {
      const opciones = await inventario();
      if (opciones.length) {
        salida(resumen(opciones));
        const pregunta = opciones.length === 1 ? "Adaptador [1, 0 para demo] > " : "Adaptador [número, 0 para demo] > ";
        const opcion = (await preguntar(pregunta)).trim() || (opciones.length === 1 ? "1" : "");
        config.adaptador = /^[1-9][0-9]*$/.test(opcion) ? opciones[Number(opcion) - 1]?.id ?? null : null;
      } else {
        salida("Sin adaptadores Wi-Fi disponibles. Puedes empezar con la demo.");
        config.adaptador = null;
      }
    } catch (error) {
      if (error.code === "ABORT_ERR") throw error;
      salida("NetworkManager no está disponible. Puedes empezar con la demo.");
      config.adaptador = null;
    }
    await guardarJson(ruta, config);
  }
  return { proyecto, ruta, config };
}

async function aplicar(destino) {
  const salida = (texto) => console.log(seguro(texto));
  const lector = createInterface({ input: process.stdin, output: process.stdout, terminal: tty });
  const lineas = tty ? null : lector[Symbol.asyncIterator]();
  const cerrarInicio = new AbortController();
  lector.once("close", () => cerrarInicio.abort());
  let proyecto;
  let ruta;
  let config;
  try {
    ({ proyecto, ruta, config } = await configurarInicio(destino, salida,
      (pregunta) => lector.question(pregunta, { signal: cerrarInicio.signal })));
  } catch (error) {
    lector.close();
    if (error.code === "ABORT_ERR") return;
    throw error;
  }
  if (tty) lector.close();

  let interfaz;
  let agente;
  let sesion;
  let cerrando = false;
  let diagnosticoPendiente;
  const agentes = new Map();
  const agentesDir = join(proyecto, "agentes");
  let mensajes = ["Proyecto listo. Usa /ayuda o agent harwiff."];
  if (tty) {
    const estado = await ejecutar("entorno.py", ["estado"], { tiempo: 6_000 }).then(JSON.parse).catch(() => ({}));
    mensajes.push(estado.docker ? "Docker disponible. OpenSandbox se inicia con /diagnostico."
      : "Docker inaccesible. /diagnostico demo está disponible.");
  }
  const app = (...args) => ejecutar("app.py", ["--proyecto", proyecto, ...args]);
  function actualizar() {
    interfaz?.render({
      proyecto: seguro(basename(proyecto)), cliente: config.cliente,
      agente: agente?.id, agentes: [...agentes.values()],
      mensajes: agente ? agente.mensajes : mensajes,
    });
  }
  function mostrar(texto, destino = agente) {
    const limpio = seguro(texto);
    if (!tty) salida(limpio);
    if (destino) destino.mensajes = [...destino.mensajes.slice(-149), limpio];
    else mensajes = [...mensajes.slice(-149), limpio];
    actualizar();
  }
  function volver() {
    agente = undefined;
    actualizar();
  }
  function cerrar() {
    if (cerrando) return;
    cerrando = true;
    diagnosticoPendiente?.abort();
    for (const item of agentes.values()) item.controlador?.abort();
    interfaz?.cerrar();
    lector.close();
  }
  function enfocar(id) {
    agente = agentes.get(id);
    actualizar();
  }

  try {
    for (const id of await directorios(agentesDir)) {
      if (ID_SESION.test(id)) await cargarAgente(id);
    }
    if (tty) {
      const { pantalla } = await import("./pantalla.mjs");
      interfaz = pantalla(comandos, { salir: cerrar, volver, entrar: enfocar });
      actualizar();
    } else {
      salida(`Harwiff · ${config.cliente} · ${proyecto}`);
    }
    process.on("SIGTERM", cerrar);
    while (!cerrando) {
      const entrada = interfaz ? await interfaz.leer() : (await lineas.next()).value;
      if (entrada === undefined || cerrando) break;
      const texto = entrada.trim();
      if (!texto) continue;
      if (tty) mostrar(`${agente ? "Tú" : "wifi >"}  ${texto}`);
      try {
        await procesar(texto);
      } catch (error) {
        mostrar(`Error: ${error.message}`);
      }
    }
  } finally {
    cerrar();
    process.off("SIGTERM", cerrar);
    await Promise.allSettled([...agentes.values()].map((item) => item.trabajo));
  }

  async function cargarAgente(id) {
    const dir = join(agentesDir, id);
    const datos = await leerJson(join(dir, "sesion.json")).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!datos || !["demo", "azure-foundry"].includes(datos.modo)) return;
    const turnos = await leerTurnos(dir);
    const texto = [];
    for (const turno of turnos) {
      if (turno.estado !== "completo") {
        const usuario = turno.usuario ?? turno.mensajes?.find((m) => m.role === "user");
        if (usuario) texto.push(`Consulta pendiente: ${seguro(usuario.content)}`);
        continue;
      }
      for (const mensaje of turno.mensajes) {
        if (mensaje.role === "user") texto.push(`Tú  ${seguro(mensaje.content)}`);
        if (mensaje.role === "assistant") {
          for (const parte of mensaje.content) if (parte.type === "text") texto.push(`Harwiff  ${seguro(parte.text)}`);
        }
      }
    }
    const ultimo = turnos.at(-1);
    const estado = ultimo?.estado === "cancelado" ? "detenida" :
      ultimo && ultimo.estado !== "completo" ? "interrumpida" : "lista";
    agentes.set(id, { ...datos, id, dir, estado, mensajes: texto.slice(-150) });
  }

  async function abrirAgente(args) {
    const partes = args.split(/\s+/).slice(2);
    const usaDemo = partes.includes("--demo");
    const ids = partes.filter((parte) => parte !== "--demo");
    if (ids.length > 1 || partes.length > ids.length + 1) throw new Error("Usa agent harwiff [id] [--demo].");
    const reciente = [...agentes.values()].filter((item) => !usaDemo || item.modo === "demo")
      .sort((a, b) => b.uso.localeCompare(a.uso))[0];
    const id = ids[0] || reciente?.id || (usaDemo ? "demo" : "harwiff");
    if (!ID_SESION.test(id)) throw new Error("ID de agente inválido.");
    let item = agentes.get(id);
    if (!item) {
      const modo = usaDemo || config.cliente === "demo" ? "demo" : config.cliente;
      if (modo !== "demo" && modo !== "azure-foundry") {
        throw new Error(`El cliente ${config.cliente} se usa por separado. Dentro de Harwiff puedes usar agent harwiff --demo.`);
      }
      const dir = join(agentesDir, id);
      await mkdir(join(dir, "turnos"), { recursive: true, mode: 0o700 });
      item = { id, dir, modo, estado: "lista", mensajes: ["Sesión de agente lista. Escribe una consulta."] };
      agentes.set(id, item);
    }
    if (usaDemo && item.modo !== "demo") throw new Error("Esa sesión usa Foundry. Elige otro ID para la demo.");
    item.uso = new Date().toISOString();
    await guardarJson(join(item.dir, "sesion.json"), { modo: item.modo, uso: item.uso });
    enfocar(id);
    if (!tty) {
      mostrar(`Agente ${id} · ${item.modo} · ${item.estado}`);
      for (const mensaje of item.mensajes.slice(-12)) salida(mensaje);
    }
  }

  function iniciarTurno(texto) {
    const item = agente;
    if (item.trabajo) throw new Error("El turno anterior sigue trabajando. Usa /detener para cancelarlo.");
    const control = new AbortController();
    item.controlador = control;
    item.estado = "trabajando";
    actualizar();
    const signal = AbortSignal.any([control.signal, AbortSignal.timeout(120_000)]);
    item.trabajo = auditar(proyecto, {
      origen: "agente", sesion: item.id, operacion: "turno", proveedor: item.modo,
    }, async (id) => {
      const modelo = item.modo === "demo" ? { modelo: MODELO_DEMO } : modeloFoundry(config);
      await responder({
        id, sesion: item.dir, texto, ...modelo, signal,
        streamFn: item.modo === "demo" ? demo : undefined,
        async leerContexto() {
          let informes;
          await auditar(proyecto, {
            origen: "agente", sesion: item.id, padre: id, operacion: "leer_informes", motor: "archivos-locales",
          }, async () => {
            informes = await informesAgente(proyecto);
            return { evidencia: { informes: informes.map(({ id }) => id) } };
          }, signal);
          return JSON.stringify(informes);
        },
        emitir(evento) {
          if (evento.type === "message_end" && evento.message.role === "assistant") {
            for (const parte of evento.message.content) if (parte.type === "text") mostrar(`Harwiff  ${parte.text}`, item);
          }
        },
      });
      return { evidencia: { referencia: `agentes/${item.id}/turnos/${id}/resultado.json` } };
    }, signal).then(() => {
      item.estado = "lista";
    }, (error) => {
      item.estado = control.signal.aborted ? "detenida" : "interrumpida";
      mostrar(control.signal.aborted ? "Turno detenido." : `Turno interrumpido. ${error.message}`, item);
    }).finally(() => {
      item.controlador = undefined;
      item.trabajo = undefined;
      actualizar();
    });
  }

  async function procesar(texto) {
    if (texto === "/salir") return cerrar();
    if (texto === "/volver") {
      volver();
      if (!tty) salida("wifi >");
      return;
    }
    if (texto === "/detener") {
      if (!agente?.controlador) throw new Error("No hay un turno activo en esta sesión.");
      agente.controlador.abort();
      return;
    }
    if (agente && !texto.startsWith("/")) {
      iniciarTurno(texto);
      if (!tty) await agente.trabajo;
      return;
    }
    if (agente) throw new Error("Usa Esc o /volver para usar los comandos del proyecto.");
    if (/^agent\s+harwiff(?:\s|$)/.test(texto)) return abrirAgente(texto);
    if (texto === "ls") texto = "/sesiones";
    const [comando] = texto.split(/\s+/);
    const args = texto.slice(comando.length).trim();
    switch (comando) {
      case "/ayuda":
        mostrar(Object.entries(comandos).map(([nombre, ayuda]) => `${nombre}  ${ayuda}`).join("\n"));
        break;
      case "/adaptador": {
        const invent = await inventario();
        if (!args) {
          mostrar(resumen(invent) || "No se detectó un adaptador Wi-Fi.");
          mostrar(`Seleccionado: ${invent.find((item) => item.id === config.adaptador)?.interfaz ?? "ninguno o desconectado"} · /adaptador <número>`);
          break;
        }
        const elegido = /^[1-9][0-9]*$/.test(args) ? invent[Number(args) - 1] : undefined;
        if (!elegido) throw new Error("Elige un número de la lista de /adaptador.");
        config = { ...config, adaptador: elegido.id };
        await guardarJson(ruta, config);
        mostrar(`Adaptador seleccionado: ${elegido.interfaz} · ${elegido.tipo}`);
        break;
      }
      case "/config": {
        if (!args) {
          mostrar(`Cliente: ${config.cliente} · OpenSandbox local: puerto ${config.puertoSandbox || "automático"}`);
          if (config.cliente === "azure-foundry") {
            mostrar(`Dominio: ${config.foundry?.host || "pendiente"} · Deployment: ${config.foundry?.deployment || "pendiente"}`);
          }
          break;
        }
        const [host, deployment, extra] = args.split(/\s+/);
        if (host === "sandbox") {
          const puerto = deployment === "auto" ? 0 : Number(deployment);
          if (extra || !(puerto === 0 && deployment === "auto") &&
              !(Number.isInteger(puerto) && puerto >= 1024 && puerto <= 65535)) {
            throw new Error("Usa /config sandbox auto o /config sandbox <puerto entre 1024 y 65535>.");
          }
          config = { ...config, puertoSandbox: puerto };
          await guardarJson(ruta, config);
          mostrar("Configuración de OpenSandbox guardada.");
          break;
        }
        if (config.cliente !== "azure-foundry" || extra || !DOMINIO_AZURE.test(host) ||
            !deployment || !DEPLOYMENT_AZURE.test(deployment)) {
          throw new Error("Usa /config <dominio Azure> <deployment> en un proyecto Azure Foundry.");
        }
        config = { ...config, foundry: { host, deployment } };
        await guardarJson(ruta, config);
        mostrar("Configuración guardada.");
        break;
      }
      case "/diagnostico": {
        if (args && args !== "demo") throw new Error("Usa /diagnostico [demo].");
        diagnosticoPendiente = new AbortController();
        const signal = diagnosticoPendiente.signal;
        const esDemo = args === "demo";
        mostrar(esDemo ? "Preparando muestra sintética…" : "Ejecutando diagnóstico en OpenSandbox…");
        try {
          const id = await auditar(proyecto, {
            origen: "usuario", sesion, operacion: "diagnostico",
            adaptador: esDemo ? undefined : config.adaptador, motor: esDemo ? "demo-local" : "opensandbox",
          }, async (run) => {
            if (!esDemo && !config.adaptador) throw errorBloqueado("Selecciona un adaptador con /adaptador.");
            if (!esDemo && !(await inventario()).some((item) => item.id === config.adaptador)) {
              throw errorBloqueado("El adaptador elegido no está disponible. Usa /adaptador.");
            }
            let informe;
            try {
              const op = esDemo ? ["demo"] : ["diagnostico", "--adaptador", config.adaptador,
                "--puerto", String(config.puertoSandbox || 0)];
              informe = JSON.parse(await ejecutar("entorno.py", op, { signal }));
            } catch (error) {
              error.publico = error.message;
              throw error;
            }
            return { evidencia: await guardarInforme(proyecto, run, informe) };
          }, signal);
          mostrar(`Informe guardado: informes/${id}.json · /auditoria ${id}`);
        } finally {
          diagnosticoPendiente = undefined;
        }
        break;
      }
      case "/auditoria":
        if (args) mostrar(JSON.stringify(await leerAuditoria(proyecto, args), null, 2));
        else {
          const ids = (await idsAuditoria(proyecto)).slice(-30);
          for (const id of ids) {
            const run = await leerAuditoria(proyecto, id);
            mostrar(`${id} · ${run.operacion} · ${run.estado}`);
          }
          if (!ids.length) mostrar("Todavía no hay ejecuciones registradas.");
        }
        break;
      case "/sesiones":
        mostrar(await app("sesiones") || "Todavía no hay sesiones de trabajo.");
        break;
      case "/nueva": {
        let [id] = args.split(/\s+/, 1);
        let objetivo = args.slice(id.length).trim();
        if (!id && interfaz) id = (await interfaz.preguntar("Nombre de sesión (Enter para cancelar) > "))?.trim();
        if (!id && interfaz) break;
        if (!ID_SESION.test(id)) throw new Error("Usa /nueva <id> [objetivo].");
        if (!objetivo && interfaz) objetivo = (await interfaz.preguntar(
          "Objetivo [Revisar la conectividad Wi-Fi] > "))?.trim();
        if (cerrando) break;
        objetivo ||= "Revisar la conectividad Wi-Fi";
        await app("nueva", id, "--objetivo", objetivo);
        sesion = id;
        mostrar(`Sesión de trabajo: ${sesion}`);
        break;
      }
      case "/abrir": {
        let id = args;
        if (!id) {
          const ids = (await app("sesiones")).split("\n").filter(Boolean);
          mostrar(ids.map((nombre, indice) => `${indice + 1}. ${nombre}`).join("\n")
            || "Todavía no hay sesiones de trabajo. Usa /nueva.");
          if (!interfaz || !ids.length) break;
          const opcion = (await interfaz.preguntar("Número de sesión (Enter para cancelar) > "))?.trim();
          if (!opcion) break;
          id = /^[1-9][0-9]*$/.test(opcion) ? ids[Number(opcion) - 1] : undefined;
          if (!id) throw new Error("Elige un número de la lista.");
        }
        mostrar(await app("abrir", id));
        sesion = id;
        break;
      }
      case "/guardar":
        if (!sesion || !args) throw new Error("Abre una sesión de trabajo y usa /guardar <nota>.");
        mostrar(await ejecutar("app.py", ["--proyecto", proyecto, "guardar", sesion], { entrada: args }));
        break;
      case "/contexto":
        mostrar(sesion ? await app("abrir", sesion) : JSON.stringify(await informesAgente(proyecto), null, 2));
        break;
      default:
        throw new Error("Usa /ayuda o inicia una conversación con agent harwiff.");
    }
  }
}

try {
  const [destino, ...extra] = process.argv.slice(2);
  if (destino === "--version" && !extra.length) console.log(`Harwiff ${VERSION}`);
  else if (["--help", "-h"].includes(destino) && !extra.length) console.log("Uso: harwiff [carpeta-del-proyecto]");
  else if (extra.length || destino?.startsWith("-")) throw new Error("Uso: harwiff [carpeta-del-proyecto]");
  else await aplicar(destino);
} catch (error) {
  console.error(`Error: ${seguro(error.message)}`);
  process.exitCode = 1;
}
