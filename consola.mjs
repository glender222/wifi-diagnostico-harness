#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { basename, join, parse, resolve } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

import { DEPLOYMENT_AZURE, DOMINIO_AZURE, ejecutarPi, guardarJson, leerTurnos, modeloFoundry, responder } from "./bucle.mjs";
import { crearCredencialesOpenAI } from "./credenciales-openai.mjs";
import { conBloqueoProyecto, ejecutar, entorno } from "./entorno.mjs";
import { detalleAdaptador, panelAdaptadores } from "./panel-adaptadores.mjs";
import {
  ID_SESION, auditar, descubrirProyectos, directorios, guardarAlcance, guardarCambioConfiguracion, guardarInforme, idsAuditoria,
  informesAgente, inspeccionarControlWifi, leerActividadProyecto, leerAuditoria, leerControlWifi, leerJson, localizarProyecto,
  resumenControlWifi, usarAdaptador,
} from "./proyecto.mjs";
import { comprobarHerramientasOpenAI, listarModelosOpenAI, ocultarClaveOpenAI, validarModeloOpenAI } from "./proveedor-openai.mjs";
import { cargarSesionAutonoma, enviarMensajeAgente, etiquetaProveedor, iniciarSesionAgente, PROVEEDORES_AGENTE, proveedorAgente } from "./sesion-agente.mjs";

const VERSION = "0.2.6";
const NOMBRE_ENTORNO = "harwiff";
const PROMPT_ENTORNO = `${NOMBRE_ENTORNO} >`;
const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const seguro = (texto) => ocultarClaveOpenAI(String(texto)).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
const comandos = {
  "/ayuda": "Comandos del entorno",
  "/init": "Inicializar Harwiff en la carpeta actual",
  "/proyecto": "Crear o abrir un proyecto",
  "/proyectos": "Listar y abrir proyectos de una ruta",
  "/adaptador": "Consultar inventario y elegir adaptador",
  "/diagnostico": "Ejecutar en OpenSandbox o usar /diagnostico demo",
  "/alcance": "Definir o ver el alcance autorizado",
  "/agente": "Iniciar una sesión sobre el escenario mock",
  "/auditoria": "Listar ejecuciones o ver una por ID",
  "/config": "Ver la configuración del proyecto",
  "/model": "Elegir el modelo para sesiones nuevas",
  "/connect": "Conectar un proveedor o consultar su estado",
  "/disconnect": "Desvincular una credencial OpenAI de Harwiff",
  "/sesiones": "Listar sesiones de trabajo del proyecto",
  "/nueva": "Crear una sesión de trabajo",
  "/abrir": "Abrir una sesión de trabajo",
  "/guardar": "Guardar una nota en la sesión de trabajo",
  "/contexto": "Ver notas e informes de la sesión de trabajo",
  "/volver": "Volver del agente al entorno",
  "/detalle": "Consultar parámetros, resultado y auditoría de una operación",
  "/detener": "Cancelar el turno del agente activo",
  "/salir": "Cerrar Harwiff",
};

function disponibles(proyecto, agente) {
  const nombres = agente ? ["/ayuda", "/config", "/detener", "/volver", "/salir", ...(agente.autonoma ? ["/detalle"] : [])]
    : proyecto ? Object.keys(comandos).filter((comando) => !["/init", "/detener", "/volver", "/detalle"].includes(comando))
      : ["/ayuda", "/init", "/proyecto", "/proyectos", "/connect", "/disconnect", "/salir"];
  return Object.fromEntries(nombres.map((comando) =>
    [comando, agente && comando === "/salir" ? "Volver al entorno sin cancelar" : comandos[comando]]));
}

function resolverCarpeta(valor) {
  if (valor === "~") return homedir();
  if (valor.startsWith("~/")) return resolve(homedir(), valor.slice(2));
  return resolve(valor);
}

const USO_LISTADO = "Uso: harwiff proyectos [--json] [--profundidad 0..5] [ruta]";

async function listarProyectos(args, json = false) {
  const options = { profundidad: { type: "string", default: "1" } };
  if (json) options.json = { type: "boolean" };
  const { values, positionals } = parseArgs({ args, options, allowPositionals: true });
  if (positionals.length > 1 || !/^[0-5]$/.test(values.profundidad)) throw new Error(USO_LISTADO);
  const ruta = resolverCarpeta(positionals[0] ?? ".");
  return { resultado: await descubrirProyectos(ruta, Number(values.profundidad)), json: values.json };
}

function textoProyectos({ ruta, proyectos }) {
  return proyectos.length
    ? proyectos.map(({ nombre, cliente, ruta }) => `${nombre} · ${cliente} · ${ruta}`).join("\n")
    : `No hay proyectos Harwiff en ${ruta}.`;
}

function esRaiz(carpeta) {
  return carpeta === parse(carpeta).root;
}

function resumen(adaptadores) {
  return adaptadores.map(({ name, tipo, activo, estado, lockedBySession }, index) =>
    `${index + 1}. ${name} · ${tipo} · ${estado}${activo ? " · conexión activa" : ""}` +
    (lockedBySession ? ` · propietario ${lockedBySession}` : "")).join("\n");
}

const USO_ALCANCE = "Usa /alcance ver o /alcance set [--bssid <mac>] [--ssid <nombre>] [--canales <1,6,11>].";

function argumentosAlcance(texto) {
  const token = /\s*(?:"((?:[^"\\]|\\["\\])*)"|'([^']*)'|([^\s"']+))(?=\s|$)/gy;
  const partes = [];
  let consumidos = 0;
  for (const coincidencia of texto.matchAll(token)) {
    const [fragmento, doble, simple, palabra] = coincidencia;
    partes.push({ valor: palabra ?? simple ?? doble.replace(/\\(["\\])/g, "$1"), citado: palabra === undefined });
    consumidos += fragmento.length;
  }
  if (consumidos !== texto.length || partes.length % 2) throw new Error(USO_ALCANCE);

  const scope = { allowedBssids: [], allowedSsids: [], allowedChannels: [] };
  for (let i = 0; i < partes.length; i += 2) {
    const [opcion, argumento] = [partes[i], partes[i + 1]];
    if (opcion.citado || (!argumento.citado && argumento.valor.startsWith("--"))) throw new Error(USO_ALCANCE);
    switch (opcion.valor) {
      case "--bssid":
        scope.allowedBssids.push(argumento.valor);
        break;
      case "--ssid":
        scope.allowedSsids.push(argumento.valor);
        break;
      case "--canales":
        if (scope.allowedChannels.length || !/^[0-9]+(?:,[0-9]+)*$/.test(argumento.valor)) throw new Error(USO_ALCANCE);
        scope.allowedChannels = argumento.valor.split(",").map(Number);
        break;
      default:
        throw new Error(USO_ALCANCE);
    }
  }
  return scope;
}

function errorBloqueado(motivo) {
  return Object.assign(new Error(motivo), { decision: "denegado", publico: motivo });
}

async function aplicar(destino) {
  const credenciales = crearCredencialesOpenAI();
  const verificaciones = new Map();
  const ocultar = (texto) => {
    let limpio = credenciales.ocultar(texto);
    for (const clave of [process.env.FOUNDRY_API_KEY, process.env.OPENSANDBOX_API_KEY]) {
      if (clave?.trim()) limpio = limpio.replaceAll(clave.trim(), "[credencial omitida]");
    }
    return limpio.replace(/\bsk-[a-zA-Z0-9_-]{8,}/g, "[credencial omitida]");
  };
  const salida = (texto) => console.log(seguro(ocultar(String(texto))));
  const lector = tty ? undefined : createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const lineas = lector?.[Symbol.asyncIterator]();
  const carpetaInicial = destino ? resolverCarpeta(destino) : process.cwd();
  let proyecto;
  let carpetaTrabajo;
  let ruta;
  let config;
  let controlWifi;
  let interfaz;
  let agente;
  let sesion;
  let cerrando = false;
  let diagnosticoPendiente;
  let agentes = new Map();
  const envios = new WeakMap();
  const cargasHistorial = new WeakMap();
  let agentesDir;
  let mensajes = [`Carpeta de trabajo: ${seguro(carpetaInicial)}`];
  const app = (...args) => ejecutar("app.py", ["--proyecto", proyecto, ...args]);
  const proyectoWifi = () => ({ raiz: proyecto, config });
  async function actualizarConfig(cambiar) {
    config = await conBloqueoProyecto(proyecto, async () => {
      const anterior = await leerJson(ruta);
      const nueva = cambiar(anterior);
      const campos = [];
      if (anterior.llm?.proveedor !== nueva.llm?.proveedor) campos.push("proveedor");
      if (anterior.llm?.openaiModelId !== nueva.llm?.openaiModelId) campos.push("modelo");
      if (anterior.foundry?.host !== nueva.foundry?.host ||
          anterior.foundry?.deployment !== nueva.foundry?.deployment) campos.push("foundry");
      if ((anterior.puertoSandbox ?? 0) !== (nueva.puertoSandbox ?? 0)) campos.push("sandbox");
      await guardarCambioConfiguracion(proyecto, campos, () => guardarJson(ruta, nueva));
      return nueva;
    });
  }
  function llmProyecto() {
    const proveedor = proveedorAgente(config);
    const modelo = proveedor === "openai" ? config.llm?.openaiModelId
      : proveedor === "azure-foundry" ? config.foundry?.deployment ?? process.env.FOUNDRY_DEPLOYMENT : undefined;
    return { proveedor: etiquetaProveedor(proveedor), modelo: proveedor ? modelo || "pendiente" : undefined };
  }
  function actualizar() {
    interfaz?.render({
      proyecto: carpetaTrabajo ? seguro(basename(carpetaTrabajo)) : undefined, rutaProyecto: proyecto, cliente: config?.cliente === "demo" ? undefined : config?.cliente,
      agente: agente?.id, agentes: [...agentes.values()].filter((item) => item.iniciado),
      mensajes: agente?.autonoma ? agente.avisos ?? [] : agente ? agente.mensajes : mensajes,
      transcript: agente?.transcript, ...(config && llmProyecto()),
      autonoma: agente?.autonoma, soloConsulta: agente?.soloConsulta, comandos: disponibles(proyecto, agente),
      controlWifi,
      promptEntorno: PROMPT_ENTORNO,
    });
  }
  function mostrar(texto, destino = agente) {
    const limpio = seguro(ocultar(String(texto)));
    if (!tty) salida(limpio);
    if (destino?.autonoma) destino.avisos = [...(destino.avisos ?? []).slice(-29), limpio];
    else if (destino) destino.mensajes = [...destino.mensajes.slice(-149), limpio];
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
    lector?.close();
  }
  async function enfocar(id) {
    const item = agentes.get(id);
    if (!item) return;
    agente = item;
    actualizar();
    await cargarHistorialAgente(item);
  }

  function cargarHistorialAgente(item) {
    if (!item.historialPendiente) return;
    if (!cargasHistorial.has(item)) {
      const carga = cargarAgente(agentesDir, item.id).then((completo) => {
        if (!completo) throw new Error("La sesión ya no está disponible.");
        Object.assign(item, completo, { historialPendiente: false });
        actualizar();
      }).finally(() => cargasHistorial.delete(item));
      cargasHistorial.set(item, carga);
    }
    return cargasHistorial.get(item);
  }

  try {
    process.on("SIGTERM", cerrar);
    process.on("SIGINT", cerrar);
    let carpetaParaInicializar;
    try {
      carpetaParaInicializar = await abrirProyectoInicial();
    } catch (error) {
      mostrar(`Error: ${error.message}`);
    }
    if (tty && !cerrando) {
      const { pantalla } = await import("./pantalla.mjs");
      interfaz = pantalla(comandos, { salir: cerrar, volver, ocultar,
        entrar(id) {
          const item = agentes.get(id);
          void enfocar(id).catch((error) => mostrar(`Error: ${error.message}`, item));
        },
        enviar(id, texto) {
          const item = agentes.get(id);
          if (item?.autonoma) void enviarConversacion(item, texto).catch((error) => mostrar(`Error: ${error.message}`, item));
        },
      });
      actualizar();
      if (carpetaParaInicializar) {
        const decision = await interfaz.elegir(`Inicializar proyecto en ${seguro(carpetaParaInicializar)}`, [
          { value: "inicializar", label: "Inicializar aquí" },
          { value: "cancelar", label: "Ahora no" },
        ], "cancelar");
        if (decision === "inicializar" && !cerrando) {
          try {
            await seleccionarProyecto(carpetaParaInicializar, { crearCarpeta: false });
          } catch (error) {
            mostrar(`Error: ${error.message}`);
          }
        }
      }
    }
    while (!cerrando) {
      const entrada = interfaz ? await interfaz.leer() : (await lineas.next()).value;
      if (entrada === undefined || cerrando) break;
      const texto = ocultar(entrada.trim());
      if (!texto) continue;
      if (tty && (texto.startsWith("/") || texto === "ls" || /^agent\s+harwiff(?:\s|$)/.test(texto))) {
        mostrar(`${agente ? "Tú" : NOMBRE_ENTORNO}  ${texto}`);
      }
      try {
        await procesar(texto);
      } catch (error) {
        mostrar(`Error: ${error.message}`);
      }
    }
  } finally {
    cerrar();
    process.off("SIGTERM", cerrar);
    process.off("SIGINT", cerrar);
    await Promise.allSettled([...agentes.values()].map(async (item) => {
      await envios.get(item);
      await item.trabajo;
    }));
  }

  async function listarConexiones() {
    if (proyecto) config = await leerJson(ruta);
    const activo = proyecto ? proveedorAgente(config) : null;
    const { fuente } = await credenciales.resolver();
    mostrar(`OpenAI API · ${fuente ? `credencial en ${fuente}` : "sin credencial"} · ` +
      `modelo ${config?.llm?.openaiModelId ?? "sin seleccionar"}${activo === "openai" ? " · seleccionado" : ""}`);
    let azure = "sin configurar";
    try {
      const { modelo } = modeloFoundry(config ?? {});
      azure = `configurado · ${modelo.id}`;
    } catch {
      // Consultar el estado local no necesita contactar al proveedor.
    }
    mostrar(`Azure AI Foundry · ${azure}${activo === "azure-foundry" ? " · seleccionado" : ""}`);
    if (proyecto && !activo) mostrar("Proyecto sin modelo configurado.");
  }

  function contextoVerificacion(entorno) {
    return createHash("sha256").update(JSON.stringify([entorno.OPENAI_API_KEY,
      entorno.OPENAI_ORG_ID, entorno.OPENAI_PROJECT_ID])).digest("hex");
  }

  function estadoModelo(id, entorno) {
    return verificaciones.get(contextoVerificacion(entorno))?.get(id) ?? "listado · pendiente de verificar";
  }

  async function probarOpenAI(id, conexion = undefined) {
    const { entorno } = conexion ?? await credenciales.resolver();
    const huella = contextoVerificacion(entorno);
    const estados = verificaciones.get(huella) ?? new Map();
    verificaciones.set(huella, estados);
    try {
      const resultado = await comprobarHerramientasOpenAI(id, { entorno });
      estados.set(id, "verificado · Responses y function calling");
      mostrar(`OpenAI Responses y function calling verificados · ${resultado.modeloDevuelto ?? resultado.modelId} · ${resultado.herramienta}`);
      const { tokens } = resultado;
      mostrar(tokens ? `Tokens de conectividad · entrada ${tokens.entrada}, salida ${tokens.salida}, total ${tokens.total}`
        : "OpenAI no informó tokens para la prueba de conectividad.");
    } catch (error) {
      if (error.code === "openai_tools_unsupported") estados.set(id, "incompatible");
      throw error;
    }
  }

  async function desvincularOpenAI() {
    verificaciones.clear();
    const estado = await credenciales.desvincular();
    mostrar(estado === "no_disponible" ? "Memoria desvinculada. No se pudo comprobar la eliminación en Secret Service."
      : "Credencial de OpenAI desvinculada de Harwiff.");
    if (process.env.OPENAI_API_KEY?.trim()) mostrar("OPENAI_API_KEY externa sigue disponible.");
  }

  async function elegirProveedor() {
    return interfaz.elegir("Conectar proveedor LLM · Enter elige · Esc cancela", [
      { value: "openai", label: "OpenAI API", description: "Responses API" },
      { value: "azure-foundry", label: "Azure AI Foundry", description: "Dominio y deployment del proyecto" },
    ], proveedorAgente(config) ?? "openai");
  }

  async function configurarFoundry() {
    const existente = config.foundry ?? {};
    const hostActual = existente.host ?? process.env.FOUNDRY_HOST ?? "";
    const deploymentActual = existente.deployment ?? process.env.FOUNDRY_DEPLOYMENT ?? "";
    const entradaHost = await interfaz.preguntar(hostActual ? `Dominio Azure [${seguro(hostActual)}] > ` : "Dominio Azure > ");
    if (entradaHost === undefined || cerrando) return;
    const entradaDeployment = await interfaz.preguntar(deploymentActual
      ? `Deployment [${seguro(deploymentActual)}] > ` : "Deployment > ");
    if (entradaDeployment === undefined || cerrando) return;
    const foundry = { host: entradaHost.trim() || hostActual, deployment: entradaDeployment.trim() || deploymentActual };
    modeloFoundry({ ...config, foundry });
    await actualizarConfig((actual) => ({ ...actual, foundry,
      llm: { ...actual.llm, proveedor: "azure-foundry" } }));
    mostrar("Azure AI Foundry configurado · Deployment: " + foundry.deployment);
  }

  async function probarFoundry() {
    const modelo = modeloFoundry(config);
    const name = "comprobar_conexion";
    let llamada = false;
    await ejecutarPi({ ...modelo,
      prompts: [{ role: "user", content: "Invoca comprobar_conexion sin argumentos.", timestamp: Date.now() }],
      herramientas: [{ name, label: name, description: "Comprueba el protocolo de herramientas.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          llamada = true;
          return { content: [{ type: "text", text: "OK" }], details: {} };
        },
      }],
      signal: AbortSignal.timeout(30_000), emitir: () => {},
      hooks: { maxRetries: 0, finishTurn: () => ({ action: "end" }) },
    }).catch(() => { throw new Error("No se pudo completar la prueba de Azure AI Foundry."); });
    if (!llamada) throw new Error("Azure AI Foundry no devolvió la llamada de prueba. Revisa acceso, cuota y deployment.");
    mostrar(`Azure AI Foundry · function calling verificado · ${modelo.modelo.id}`);
  }

  async function menuFoundry() {
    const { modelo } = modeloFoundry(config);
    const opcion = await interfaz.elegir(`Azure AI Foundry · configurado · ${modelo.id}`, [
      ...(proveedorAgente(config) !== "azure-foundry" ? [{ value: "usar", label: "Usar en este proyecto" }] : []),
      { value: "modelo", label: "Editar conexión de Foundry" },
      { value: "credencial", label: "Consultar origen de la credencial" },
      { value: "probar", label: "Probar conexión", description: "Consume tokens" },
      { value: "desconectar", label: "Desconectar del proyecto" },
    ]);
    if (opcion === "usar") await elegirModelo("azure-foundry/" + modelo.id);
    if (opcion === "modelo") await configurarFoundry();
    if (opcion === "credencial") mostrar("Azure AI Foundry usa FOUNDRY_API_KEY del entorno.");
    if (opcion === "probar") await probarFoundry();
    if (opcion === "desconectar") {
      await actualizarConfig((actual) => {
        const { foundry, ...resto } = actual;
        return { ...resto, llm: { ...resto.llm,
          proveedor: proveedorAgente(actual) === "azure-foundry" ? null : proveedorAgente(actual) } };
      });
      mostrar("Azure AI Foundry desvinculado del proyecto.");
    }
  }

  async function conectarOpenAI() {
    const entrada = await interfaz.preguntarSecreto("API key de OpenAI · entrada oculta · Esc cancela >");
    if (!entrada || cerrando) return;
    const entorno = credenciales.conClave(entrada);
    const ids = await listarModelosOpenAI({ entorno });
    if (cerrando) return;
    const fuente = await credenciales.guardar(entrada);
    verificaciones.clear();
    mostrar("OpenAI API conectado · Credencial: " + fuente);
    if (fuente === "memoria de Harwiff") mostrar("Secret Service no disponible. La clave se elimina al cerrar Harwiff.");
    if (proveedorAgente(config) !== "openai" || !ids.includes(config.llm?.openaiModelId)) {
      await elegirModelo("", { conexion: { fuente, entorno }, ids, soloOpenAI: true });
    }
  }

  function valorModeloOpenAI(id) {
    return id === "demo" || /^(openai|azure-foundry)\//.test(id) ? `openai/${id}` : id;
  }

  async function elegirModelo(args, { conexion, ids, soloOpenAI = false } = {}) {
    let elegido = args;
    if (!elegido) {
      conexion ??= await credenciales.resolver();
      const opciones = [];
      let errorOpenAI;
      if (conexion.fuente) {
        try {
          ids ??= await listarModelosOpenAI(conexion);
          for (const id of ids) opciones.push({ value: valorModeloOpenAI(id), label: id,
            description: "OpenAI · " + estadoModelo(id, conexion.entorno) });
          if (!ids.length) errorOpenAI = new Error("La API de OpenAI no devolvió modelos para este proyecto.");
        } catch (error) {
          errorOpenAI = error;
        }
      }
      let foundry;
      if (!soloOpenAI) {
        try { foundry = modeloFoundry(config).modelo.id; } catch { /* La conexión aún no está disponible. */ }
        if (foundry) opciones.push({ value: "azure-foundry/" + foundry, label: foundry, description: "Azure AI Foundry" });
      }
      if (!opciones.length) throw errorOpenAI ?? new Error("Conecta un proveedor con /connect.");
      if (errorOpenAI) mostrar("OpenAI · " + errorOpenAI.message);
      if (!interfaz) {
        mostrar(opciones.map(({ value, description }) => value + " · " + description).join("\n"));
        return false;
      }
      const proveedor = proveedorAgente(config);
      const activo = proveedor === "openai" && config.llm?.openaiModelId ? valorModeloOpenAI(config.llm.openaiModelId)
        : proveedor === "azure-foundry" ? "azure-foundry/" + foundry : undefined;
      elegido = await interfaz.elegir("Modelo para sesiones nuevas · Enter guarda · Esc cancela",
        opciones, activo, { filtrar: true });
      if (!elegido || cerrando) return false;
    }
    if (/\s/.test(elegido) || elegido === "demo") throw new Error("Usa /model [id | azure-foundry/<deployment>].");
    if (elegido.startsWith("azure-foundry/")) {
      const id = elegido.slice("azure-foundry/".length);
      await actualizarConfig((actual) => {
        if (modeloFoundry(actual).modelo.id !== id) throw new Error("El deployment seleccionado no está configurado. Usa /connect.");
        return { ...actual, llm: { ...actual.llm, proveedor: "azure-foundry" } };
      });
      mostrar(`Modelo guardado: ${id} · Azure AI Foundry`);
      return true;
    }
    const id = elegido.startsWith("openai/") ? elegido.slice("openai/".length) : elegido;
    if (args) {
      conexion ??= await credenciales.resolver();
      await validarModeloOpenAI(id, conexion);
    }
    await guardarModeloOpenAI(id);
    mostrar(`Modelo OpenAI guardado: ${id} · ${estadoModelo(id, conexion.entorno)}`);
    return true;
  }

  async function guardarModeloOpenAI(id, soloSiOpenAI = false) {
    await actualizarConfig((actual) => {
      if (soloSiOpenAI && proveedorAgente(actual) !== "openai") {
        throw new Error("El proveedor del proyecto cambió. Vuelve a seleccionar OpenAI.");
      }
      return { ...actual, llm: { ...actual.llm, proveedor: "openai", openaiModelId: id } };
    });
  }

  async function conectarProveedor() {
    if (!interfaz) throw new Error("Usa /connect en una terminal interactiva. Para scripts usa OPENAI_API_KEY y /model.");
    const elegido = await elegirProveedor();
    if (!elegido || cerrando) return;
    if (elegido === "azure-foundry") {
      try {
        modeloFoundry(config);
      } catch {
        return configurarFoundry();
      }
      return menuFoundry();
    }
    const conexion = await credenciales.resolver();
    if (!conexion.fuente) return conectarOpenAI();
    const activo = proveedorAgente(config) === "openai";
    const id = activo ? config.llm?.openaiModelId : undefined;
    const opcion = await interfaz.elegir("OpenAI API · credencial en " + conexion.fuente + " · modelo " + (id ?? "sin seleccionar"), [
      ...(!id ? [{ value: "modelo", label: "Elegir modelo para este proyecto" }] : []),
      { value: "credencial", label: "Cambiar credencial" },
      ...(id ? [{ value: "probar", label: "Probar conexión", description: "Consume tokens" }] : []),
      { value: "desconectar", label: "Desconectar" },
    ]);
    if (opcion === "modelo") return elegirModelo("", { conexion, soloOpenAI: true });
    if (opcion === "credencial") return conectarOpenAI();
    if (opcion === "probar") return probarOpenAI(id, conexion);
    if (opcion === "desconectar") return desvincularOpenAI();
  }

  async function abrirProyectoInicial() {
    if (esRaiz(carpetaInicial)) {
      mostrar("Sin proyecto. Usa /proyecto <ruta> para elegir una carpeta de trabajo.");
      return;
    }
    const info = await stat(carpetaInicial).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (!info) {
      mostrar("Sin proyecto. Usa /proyecto <ruta> para crear una carpeta de trabajo.");
      return;
    }
    if (!info.isDirectory()) throw new Error("Elige una carpeta de trabajo.");
    const fisica = await realpath(carpetaInicial);
    if (esRaiz(fisica)) {
      mostrar("Sin proyecto. Usa /proyecto <ruta> para elegir una carpeta de trabajo.");
      return;
    }
    if (await localizarProyecto(fisica)) {
      await seleccionarProyecto(fisica, { soloAbrir: true });
      return;
    }
    mostrar("Sin proyecto. Usa /init para inicializar esta carpeta.");
    return fisica;
  }

  async function seleccionarProyecto(carpeta, { cliente = "demo", soloAbrir = false, crearCarpeta = true } = {}) {
    if ([...agentes.values()].some((item) => item.trabajo || envios.has(item))) {
      throw new Error("Espera a que termine el agente o usa /detener antes de cambiar de proyecto.");
    }
    const existente = await (soloAbrir ? lstat : stat)(carpeta).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (soloAbrir && !existente?.isDirectory()) throw new Error("El proyecto ya no está disponible.");
    if (!existente && !crearCarpeta) throw new Error("La carpeta de trabajo ya no está disponible. Usa /proyecto <ruta>.");
    if (existente && !existente.isDirectory()) throw new Error("Elige una carpeta de trabajo.");
    const fisica = existente ? await realpath(carpeta) : carpeta;
    if (esRaiz(fisica)) throw new Error("Elige una carpeta de trabajo, por ejemplo /proyecto ~/wifi-prueba.");
    let ubicacion = await localizarProyecto(fisica);
    let creado = false;
    if (!ubicacion) {
      if (soloAbrir) throw new Error("El proyecto ya no está disponible.");
      const raiz = join(fisica, ".harwiff");
      try {
        await ejecutar("app.py", ["iniciar", raiz, "--cliente", cliente, "--solo-datos"]);
        creado = true;
      } catch (error) {
        // Otra consola puede completar la misma inicialización primero.
        ubicacion = await localizarProyecto(fisica);
        if (!ubicacion) throw error;
      }
      ubicacion ??= await localizarProyecto(fisica);
      if (!ubicacion) throw new Error("El proyecto inicializado ya no está disponible.");
    }
    const { raiz, archivo, config: nuevaConfig } = ubicacion;
    const [nuevoControl, actividad] = await Promise.all([
      leerControlWifi(ubicacion), leerActividadProyecto(raiz),
    ]);

    const nuevaCarpetaAgentes = join(raiz, "agentes");
    const nuevosAgentes = new Map();
    for (const id of await directorios(nuevaCarpetaAgentes)) {
      if (!ID_SESION.test(id)) continue;
      const item = await cargarAgente(nuevaCarpetaAgentes, id, { soloResumen: true });
      if (item) nuevosAgentes.set(id, item);
    }
    if (cerrando) return;
    carpetaTrabajo = fisica;
    proyecto = raiz;
    ruta = archivo;
    config = nuevaConfig;
    controlWifi = nuevoControl;
    agentesDir = nuevaCarpetaAgentes;
    agentes = nuevosAgentes;
    sesion = undefined;
    agente = undefined;
    mensajes = [];
    mostrar((creado ? "Proyecto creado" : "Proyecto abierto") + " · " + carpetaTrabajo);
    if (creado) mostrar("Datos de Harwiff guardados en .harwiff/.");
    if (!tty) {
      const { proveedor, modelo } = llmProyecto();
      mostrar(`Proveedor LLM · ${proveedor} · Modelo predeterminado ${modelo}`);
      mostrar(resumenControlWifi(controlWifi));
      for (const item of agentes.values()) {
        if (item.iniciado) mostrar(`Agente ${item.id} · ${item.estado}`);
      }
    }
    if (actividad.length) mostrar(["Actividad reciente del proyecto", ...actividad].join("\n"));
    mostrar(proveedorAgente(config) ? "Escribe una consulta para iniciar el agente."
      : "Configura el modelo del proyecto con /connect o /model para iniciar el agente.");
  }

  async function cargarAgente(raizAgentes, id, { soloResumen = false } = {}) {
    const dir = join(raizAgentes, id);
    const datos = await leerJson(join(dir, "sesion.json")).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    const autonoma = await cargarSesionAutonoma(dir, datos, { soloResumen });
    if (autonoma) return autonoma.modo === "demo" ? { ...autonoma, soloConsulta: true } : autonoma;
    if (!datos || !["demo", "azure-foundry"].includes(datos.modo)) return;
    const turnos = await leerTurnos(dir, { limite: soloResumen ? 1 : Infinity });
    const texto = [];
    for (const turno of soloResumen ? [] : turnos) {
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
    return { ...datos, id, dir, estado, historialPendiente: soloResumen, soloConsulta: datos.modo === "demo",
      iniciado: datos.iniciado === true || turnos.length > 0, mensajes: texto.slice(-150) };
  }

  async function abrirAgente(args) {
    const ids = args.split(/\s+/).slice(2);
    if (ids.length > 1 || (ids.length && !ID_SESION.test(ids[0]))) throw new Error("Usa agent harwiff [id] para abrir una sesión.");
    const reciente = [...agentes.values()].filter((item) => item.iniciado)
      .sort((a, b) => (b.uso ?? "").localeCompare(a.uso ?? ""))[0];
    const item = ids.length ? agentes.get(ids[0]) : reciente;
    if (!item) throw new Error("Usa /agente <objetivo> para iniciar una sesión.");
    await enfocar(item.id);
    if (!tty) for (const mensaje of item.mensajes.slice(-12)) salida(mensaje);
  }

  async function iniciarAgenteProyecto(objetivo, enfocarAlIniciar = false) {
    if (!objetivo || objetivo.length > 2000) throw new Error("Escribe un objetivo de entre 1 y 2000 caracteres.");
    config = await leerJson(ruta);
    let proveedor = proveedorAgente(config);
    const conexion = proveedor === "azure-foundry" ? undefined : await credenciales.resolver();
    if (proveedor === "openai" && !conexion.fuente) throw new Error("Falta la credencial de OpenAI. Conecta el proveedor con /connect.");
    if (!proveedor || (proveedor === "openai" && !config.llm?.openaiModelId)) {
      if (!conexion?.fuente) {
        try { modeloFoundry(config); } catch { throw new Error("Conecta un proveedor con /connect."); }
      }
      if (!interfaz) throw new Error("Elige un modelo para este proyecto con /model <model-id>.");
      if (!await elegirModelo("", { conexion, soloOpenAI: proveedor === "openai" })) return;
      proveedor = proveedorAgente(config);
    }
    if (cerrando) return;
    const entornoLlm = proveedor === "openai" ? conexion.entorno : undefined;
    const item = await iniciarSesionAgente({ proyecto: proyectoWifi(), objetivo, alCambiar: actualizar, entornoLlm });
    agentes.set(item.id, item);
    if (cerrando) item.controlador?.abort();
    mostrar(["Sesión iniciada", item.id, etiquetaProveedor(item.modo), item.modelId].join(" · "), null);
    if (enfocarAlIniciar && interfaz && !cerrando) await enfocar(item.id);
    if (!tty) {
      await item.trabajo;
      for (const mensaje of item.mensajes) salida(mensaje);
    }
  }

  async function iniciarTurno(texto, item) {
    await cargarHistorialAgente(item);
    if (item.soloConsulta) throw new Error("Esta sesión está disponible para consulta. Usa /agente para una nueva sesión.");
    if (item.trabajo) throw new Error("El turno anterior sigue trabajando. Usa /detener para cancelarlo.");
    const primerTurno = !item.iniciado;
    const control = new AbortController();
    item.controlador = control;
    item.estado = "trabajando";
    item.iniciado = true;
    agente = item;
    mostrar(`Tú  ${texto}`, item);
    const signal = AbortSignal.any([control.signal, AbortSignal.timeout(120_000)]);
    item.trabajo = auditar(proyecto, {
      origen: "agente", sesion: item.id, operacion: "turno", proveedor: item.modo,
    }, async (id) => {
      if (primerTurno) {
        await guardarJson(join(item.dir, "sesion.json"), { modo: item.modo, uso: item.uso, iniciado: true });
      }
      const modelo = modeloFoundry(config);
      await responder({
        id, sesion: item.dir, texto, ...modelo, signal,
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

  function enviarConversacion(item, texto) {
    const proyectoActual = proyectoWifi();
    const previo = envios.get(item) ?? Promise.resolve();
    const envio = previo.then(async () => {
      if (cerrando) return;
      await cargarHistorialAgente(item);
      if (cerrando) return;
      const resolverEntornoLlm = item.modo === "openai" ? async () => {
        const { entorno } = await credenciales.resolver();
        if (cerrando) throw new Error("Harwiff está cerrando.");
        return entorno;
      } : undefined;
      await enviarMensajeAgente({ proyecto: proyectoActual, item, texto, alCambiar: actualizar, resolverEntornoLlm });
      if (cerrando) item.controlador?.abort();
    });
    const cola = envio.catch(() => {}).finally(() => {
      if (envios.get(item) === cola) envios.delete(item);
    });
    envios.set(item, cola);
    return envio;
  }

  async function procesar(texto) {
    if (texto === "/ayuda") {
      mostrar(Object.entries(disponibles(proyecto, agente)).map(([nombre, ayuda]) => `${nombre}  ${ayuda}`).join("\n"));
      return;
    }
    if (texto === "/salir" && !agente) return cerrar();
    if (texto === "/volver" || texto === "/salir") {
      volver();
      if (!tty) salida(PROMPT_ENTORNO);
      return;
    }
    if (texto === "/detener") {
      if (!agente?.controlador) throw new Error("No hay un turno activo en esta sesión.");
      agente.controlador.abort();
      return;
    }
    if (agente && texto === "/config") {
      mostrar(`Agente: ${agente.id} · Modo: ${agente.modo} · Estado: ${agente.estado}`);
      if (agente.modelId) mostrar(`Modelo: ${agente.modelId}`);
      if (agente.modo === "azure-foundry") {
        mostrar(`Deployment: ${config.foundry?.deployment ?? process.env.FOUNDRY_DEPLOYMENT ?? "pendiente"}`);
      }
      return;
    }
    if (agente && !texto.startsWith("/")) {
      const item = agente;
      if (item.autonoma) {
        const previos = item.mensajes.length;
        await enviarConversacion(item, texto);
        if (!tty) {
          await item.trabajo;
          for (const mensaje of item.mensajes.slice(previos)) salida(mensaje);
        }
      } else {
        await iniciarTurno(texto, item);
        if (!tty) await item.trabajo;
      }
      return;
    }
    if (agente?.autonoma && (texto === "/detalle" || texto.startsWith("/detalle "))) {
      const item = agente;
      await cargarHistorialAgente(item);
      if (agente !== item) return;
      const opciones = item.operaciones.filter(({ auditId }) => auditId);
      if (!opciones.length) throw new Error("Todavía no hay operaciones con auditoría en esta sesión.");
      const id = texto.slice("/detalle".length).trim() || (interfaz && await interfaz.elegir("Detalles de operaciones",
        opciones.map(({ tool, auditId, autorizacion }) => ({ value: auditId, label: tool,
          description: `${autorizacion?.decision ?? ""} · ${auditId}` }))));
      if (!id) return;
      const operacion = opciones.find(({ auditId }) => auditId === id);
      if (!operacion) throw new Error("Ese ID no corresponde a una operación de esta sesión.");
      const registro = await leerAuditoria(proyecto, operacion.auditId);
      const detalle = seguro(ocultar([
        `Herramienta · ${operacion.tool} · ${registro.autorizacion?.decision} · ${registro.autorizacion?.motivo}`,
        `Parámetros · ${JSON.stringify(operacion.parametros ?? registro.parametrosNormalizados ?? {})}`,
        `Auditoría · ${operacion.auditId}`,
        `Resultado · ${JSON.stringify(operacion.result)}`,
        `Evidencias · ${JSON.stringify(registro.referenciasEvidencia ?? [])}`,
      ].join("\n")));
      if (interfaz) await interfaz.mostrarDetalle(detalle);
      else mostrar(detalle);
      return;
    }
    if (agente) throw new Error("Usa Esc o /volver para usar los comandos del proyecto.");
    if (texto === "ls") texto = "/sesiones";
    const [comando] = texto.split(/\s+/);
    const args = texto.slice(comando.length).trim();
    if (comando === "/init") {
      if (args) throw new Error("Usa /init para esta carpeta o /proyecto <ruta> para otra.");
      if (proyecto) {
        mostrar(`Proyecto ya inicializado · ${carpetaTrabajo}`);
        return;
      }
      await seleccionarProyecto(carpetaInicial, { crearCarpeta: false });
      return;
    }
    if (comando === "/proyecto") {
      const foundry = args === "--foundry" || args.startsWith("--foundry ");
      let carpeta = foundry ? args.slice("--foundry".length).trim() : args;
      if (!carpeta && interfaz) {
        const predeterminada = esRaiz(carpetaInicial) ? "" : destino ?? ".";
        if (predeterminada) mostrar(`Enter usa ${seguro(carpetaInicial)}. Esc cancela.`);
        const respuesta = await interfaz.preguntar(predeterminada
          ? `Carpeta [${seguro(predeterminada)}] > ` : "Carpeta (ej. ~/wifi-prueba) > ");
        if (respuesta === undefined || cerrando) return;
        carpeta = respuesta.trim() || predeterminada;
        if (!carpeta) throw new Error("Escribe una ruta, por ejemplo /proyecto ~/wifi-prueba.");
      }
      if (!carpeta) throw new Error("Usa /proyecto [--foundry] <carpeta>.");
      await seleccionarProyecto(resolverCarpeta(carpeta), { cliente: foundry ? "azure-foundry" : "demo" });
      return;
    }
    if (comando === "/proyectos") {
      const bandera = /^--profundidad(?:=|\s+)(\S+)(?:\s+(.*))?$/.exec(args);
      const lista = bandera ? ["--profundidad", bandera[1], ...(bandera[2] ? [bandera[2]] : [])] : args ? [args] : [];
      const { resultado } = await listarProyectos(lista);
      for (const aviso of resultado.avisos) mostrar(`Aviso: ${aviso.ruta} · ${aviso.motivo}`);
      if (!interfaz || !resultado.proyectos.length) {
        mostrar(textoProyectos(resultado));
        return;
      }
      const opciones = resultado.proyectos.map(({ nombre, cliente, ruta }) => ({
        value: ruta,
        label: seguro(ruta === carpetaTrabajo ? `${nombre} (activo)` : nombre),
        description: seguro(`${cliente} · ${ruta}`),
      }));
      const seleccion = await interfaz.elegir(`Proyectos en ${seguro(resultado.ruta)} · ↑ ↓ Enter · Esc cancela`,
        opciones, carpetaTrabajo);
      if (seleccion && !cerrando) await seleccionarProyecto(seleccion, { soloAbrir: true });
      return;
    }
    if (comando === "/connect" && args === "list") return listarConexiones();
    if (comando === "/disconnect") {
      if (args !== "openai") throw new Error("Usa /disconnect openai.");
      return desvincularOpenAI();
    }
    if (!proyecto) {
      mostrar("Usa /init para esta carpeta o /proyecto <ruta> para otra.");
      return;
    }
    if (/^agent\s+harwiff(?:\s|$)/.test(texto)) return abrirAgente(texto);
    if (!texto.startsWith("/")) return iniciarAgenteProyecto(texto, true);
    switch (comando) {
      case "/model":
      case "/models":
        config = await leerJson(ruta);
        await elegirModelo(args);
        break;
      case "/connect": {
        config = await leerJson(ruta);
        if (!args) await conectarProveedor();
        else if (args === "test") {
          if (proveedorAgente(config) === "azure-foundry") await probarFoundry();
          else await probarOpenAI(config.llm?.openaiModelId);
        } else throw new Error("Usa /connect, /connect list o /connect test.");
        break;
      }
      case "/agente":
        await iniciarAgenteProyecto(args);
        break;
      case "/adaptador": {
        if (!args && interfaz) {
          controlWifi = await leerControlWifi(proyectoWifi());
          await panelAdaptadores(interfaz, seguro(controlWifi.adapter?.name ?? "ninguno"), async (name, id, observado) => {
            controlWifi = await usarAdaptador(proyectoWifi(), name, id, observado);
            mostrar("Adaptador seleccionado: " + controlWifi.adapter.name + " · Preflight: OK");
          });
          break;
        }
        const detalle = /^detalle\s+(\S+)$/.exec(args)?.[1];
        if (detalle) {
          const texto = seguro(await detalleAdaptador(detalle));
          if (interfaz) await interfaz.mostrarDetalle(texto, "Harwiff / Adaptadores · Esc vuelve a harwiff >");
          else mostrar(texto);
          break;
        }
        if (!args || args === "listar") {
          const { adaptadores, aviso } = await entorno("adaptadores");
          controlWifi = await leerControlWifi(proyectoWifi());
          const seleccionado = adaptadores.find(({ id }) => id === controlWifi.adapter?.id);
          mostrar(resumen(adaptadores));
          if (aviso) mostrar(`Aviso: ${aviso}`);
          mostrar(`Seleccionado: ${seleccionado?.name ?? controlWifi.adapter?.name ?? "ninguno o desconectado"} · /adaptador usar <nombre>`);
          break;
        }
        let name = /^usar\s+(\S+)$/.exec(args)?.[1];
        let id;
        if (/^[1-9][0-9]*$/.test(args)) {
          const { adaptadores } = await entorno("adaptadores");
          const elegido = adaptadores[Number(args) - 1];
          name = elegido?.name;
          id = elegido?.id;
        }
        if (!name) throw new Error("Usa /adaptador listar, /adaptador detalle <nombre>, /adaptador usar <nombre> o /adaptador <número>.");
        controlWifi = await usarAdaptador(proyectoWifi(), name, id);
        mostrar(`Adaptador seleccionado: ${controlWifi.adapter.name} · Preflight: OK`);
        break;
      }
      case "/alcance": {
        if (args === "ver") {
          const { estado, lockedBySession } = await inspeccionarControlWifi(proyectoWifi());
          controlWifi = estado;
          const adapter = estado.adapter && { name: estado.adapter.name, mode: estado.adapter.mode, lockedBySession };
          mostrar(JSON.stringify({ adapter, scope: estado.scope, snapshot: estado.snapshot, preflight: estado.preflight }, null, 2));
          break;
        }
        if (!/^set(?:\s|$)/.test(args)) throw new Error(USO_ALCANCE);
        controlWifi = await guardarAlcance(proyectoWifi(), argumentosAlcance(args.slice(3).trim()));
        mostrar("Alcance guardado.");
        if (controlWifi.preflight) {
          mostrar(controlWifi.preflight.ok ? "Preflight: OK" : controlWifi.preflight.errors.join(" "));
        } else mostrar("Selecciona un adaptador con /adaptador usar <nombre>.");
        break;
      }
      case "/config": {
        config = await leerJson(ruta);
        if (!args) {
          mostrar(`Cliente: ${config.cliente} · OpenSandbox local: puerto ${config.puertoSandbox || "automático"}`);
          const proveedor = proveedorAgente(config);
          mostrar(`Proveedor de /agente: ${proveedor ?? "sin configurar"}${proveedor === "openai" ? ` · Modelo: ${config.llm.openaiModelId || "pendiente"}` : ""}`);
          if (proveedor === "azure-foundry" || config.cliente === "azure-foundry") {
            mostrar(`Dominio: ${config.foundry?.host || "pendiente"} · Deployment: ${config.foundry?.deployment || "pendiente"}`);
          }
          break;
        }
        const [host, deployment, extra] = args.split(/\s+/);
        if (host === "proveedor") {
          if (extra || !PROVEEDORES_AGENTE.includes(deployment)) throw new Error("Usa /config proveedor <openai|azure-foundry>.");
          await actualizarConfig((actual) => ({ ...actual, llm: { ...actual.llm, proveedor: deployment } }));
          mostrar(`Proveedor de /agente: ${deployment}`);
          break;
        }
        if (host === "modelos") {
          if (deployment) throw new Error("Usa /config modelos.");
          const conexion = await credenciales.resolver();
          const modelos = await listarModelosOpenAI(conexion);
          mostrar(modelos.length ? `Modelos disponibles en tu proyecto OpenAI: ${modelos
            .map((id) => `${id} (${estadoModelo(id, conexion.entorno)})`).join(", ")}`
            : "La API de OpenAI no devolvió modelos para este proyecto.");
          break;
        }
        if (host === "modelo") {
          if (extra || !deployment) throw new Error("Usa /config modelo <model-id>.");
          if (proveedorAgente(config) !== "openai") throw new Error("Selecciona primero /config proveedor openai.");
          await validarModeloOpenAI(deployment, await credenciales.resolver());
          await guardarModeloOpenAI(deployment, true);
          mostrar(`Modelo OpenAI guardado: ${deployment}`);
          break;
        }
        if (host === "sandbox") {
          const puerto = deployment === "auto" ? 0 : Number(deployment);
          if (extra || !(puerto === 0 && deployment === "auto") &&
              !(Number.isInteger(puerto) && puerto >= 1024 && puerto <= 65535)) {
            throw new Error("Usa /config sandbox auto o /config sandbox <puerto entre 1024 y 65535>.");
          }
          await actualizarConfig((actual) => ({ ...actual, puertoSandbox: puerto }));
          mostrar("Configuración de OpenSandbox guardada.");
          break;
        }
        if ((config.cliente !== "azure-foundry" && proveedorAgente(config) !== "azure-foundry") || extra || !DOMINIO_AZURE.test(host) ||
            !deployment || !DEPLOYMENT_AZURE.test(deployment)) {
          throw new Error("Usa /config <dominio Azure> <deployment> en un proyecto Azure Foundry.");
        }
        await actualizarConfig((actual) => ({ ...actual, foundry: { host, deployment } }));
        mostrar("Configuración guardada.");
        break;
      }
      case "/diagnostico": {
        if (args && args !== "demo") throw new Error("Usa /diagnostico [demo].");
        const actual = args === "demo" ? undefined : await leerControlWifi(proyectoWifi());
        const adaptador = actual?.adapter;
        const esDemo = args === "demo" || adaptador?.id === "mock";
        diagnosticoPendiente = new AbortController();
        const signal = diagnosticoPendiente.signal;
        mostrar(esDemo ? "Preparando muestra sintética…" : "Ejecutando diagnóstico en OpenSandbox…");
        try {
          const id = await auditar(proyecto, {
            origen: "usuario", sesion, operacion: "diagnostico",
            adaptador: adaptador?.id, motor: esDemo ? "demo-local" : "opensandbox",
          }, async (run) => {
            if (!esDemo && !adaptador) throw errorBloqueado("Selecciona un adaptador con /adaptador usar.");
            let informe;
            try {
              if (esDemo) informe = await entorno("demo", undefined, { signal });
              else {
                const resultado = await entorno("diagnostico", {
                  id: adaptador.id, scope: actual.scope, runId: run, port: config.puertoSandbox || 0,
                }, { signal, tiempo: 480_000 });
                if (resultado.bloqueado) throw errorBloqueado(resultado.bloqueado);
                informe = resultado.informe;
              }
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
        if (!objetivo && interfaz) {
          const respuesta = await interfaz.preguntar("Objetivo [Revisar la conectividad Wi-Fi] > ");
          if (respuesta === undefined) break;
          objetivo = respuesta.trim();
        }
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
        throw new Error(`Comando desconocido: ${comando}. Usa /ayuda para ver las opciones.`);
    }
  }
}

try {
  const [destino, ...extra] = process.argv.slice(2);
  if (destino === "proyectos") {
    if (extra.length === 1 && ["--help", "-h"].includes(extra[0])) console.log(USO_LISTADO);
    else {
      const { resultado, json } = await listarProyectos(extra, true);
      if (json) console.log(JSON.stringify(resultado, null, 2));
      else {
        console.log(seguro(textoProyectos(resultado)));
        for (const aviso of resultado.avisos) console.error(seguro(`Aviso: ${aviso.ruta} · ${aviso.motivo}`));
      }
    }
  } else if (destino === "--version" && !extra.length) console.log(`Harwiff ${VERSION}`);
  else if (["--help", "-h"].includes(destino) && !extra.length) console.log(`Uso: harwiff [carpeta-del-proyecto]\n${USO_LISTADO}`);
  else if (extra.length || destino?.startsWith("-")) throw new Error("Uso: harwiff [carpeta-del-proyecto]");
  else await aplicar(destino);
} catch (error) {
  console.error(`Error: ${seguro(error.message)}`);
  process.exitCode = 1;
}
