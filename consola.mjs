#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, parse, resolve } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { DEPLOYMENT_AZURE, DOMINIO_AZURE, ejecutarPi, guardarJson, leerTurnos, modeloFoundry, responder } from "./bucle.mjs";
import { inspeccionar, interpretarInspeccion } from "./inspeccion.mjs";
import { resolverModeloInspeccion } from "./modelo-inspeccion.mjs";
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

import paquete from "./package.json" with { type: "json" };

async function versionInstalada() {
  const info = await leerJson(new URL("./build-info.json", import.meta.url)).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  let commit = info?.commit;
  if (!info) {
    try {
      commit = execFileSync("git", ["-C", dirname(fileURLToPath(import.meta.url)), "rev-parse", "HEAD"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim();
    } catch { /* También se puede ejecutar desde un archivo de fuentes. */ }
  }
  const partes = [`Harwiff ${paquete.version}`, info?.canal ?? "fuente"];
  if (/^[0-9a-f]{40}$/.test(commit)) partes.push(commit.slice(0, 12));
  if (info?.cambiosLocales) partes.push("cambios locales");
  return partes.join(" · ");
}

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
  "/agente": "Sesión mock o /agente --inspeccion [opciones] -- objetivo",
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

const ESTADOS_AGENTE = {
  created: "Preparando", running: "Trabajando", trabajando: "Trabajando", completed: "Finalizada",
  lista: "Lista", cancelled: "Cancelada", detenida: "Cancelada", interrupted: "Interrumpida",
  interrumpida: "Interrumpida", error: "Error",
};

function estadoAgente(item) {
  return item.soloConsulta && item.actividad === "activa en otra consola"
    ? "Activa en otra consola" : ESTADOS_AGENTE[item.estado] ?? item.estado;
}

function actividadAgente(item) {
  return (item?.operaciones ?? []).map(({ tool, auditId, llamadaId, result, autorizacion }) => ({
    value: auditId ?? llamadaId,
    label: tool.replaceAll("_", " "),
    description: !result ? "En curso" : result.code === "cancelled" ? "Cancelada" :
      autorizacion?.decision === "DENIED" && autorizacion.motivo !== "broker_error" ? "Denegada" :
        !result.ok ? "Error" : result.inventarioEstado === "partial" ? "Parcial" :
          result.inventarioEstado === "unavailable" ? "Sin datos" : "Completada",
  }));
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
  let inspeccionPendiente;
  let carpetaParaInicializar;
  let adaptadorAusente;
  const objetivosPendientes = new Map();
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
  function hayTrabajo() {
    return Boolean(diagnosticoPendiente || inspeccionPendiente) || [...agentes.values()].some((item) => item.trabajo || envios.has(item));
  }

  function adaptadorVisible() {
    const adaptador = controlWifi?.adapter;
    if (!adaptador) return "Pendiente";
    if (adaptador.id === "mock") return "mock (simulado)";
    return (adaptador.name ?? "Adaptador guardado") + (adaptador.id === adaptadorAusente ? " (desconectado)" : "");
  }

  function tieneAlcance() {
    const scope = controlWifi?.scope;
    return Boolean(scope?.allowedSsids.length || scope?.allowedBssids.length);
  }

  function resumenAlcance() {
    const scope = controlWifi?.scope;
    if (!tieneAlcance()) return "Pendiente";
    return [
      [scope.allowedSsids.length, "SSID", "SSID"],
      [scope.allowedBssids.length, "BSSID", "BSSID"],
      [scope.allowedChannels.length, "canal", "canales"],
    ].filter(([total]) => total).map(([total, singular, plural]) => `${total} ${total === 1 ? singular : plural}`).join(", ");
  }

  function menuPrincipal() {
    if (!proyecto) return [
      { value: "abrirProyecto", label: "Abrir proyecto" },
      { value: "crearProyecto", label: "Crear proyecto" },
      ...(carpetaParaInicializar ? [{ value: "inicializar", label: "Inicializar esta carpeta",
        description: seguro(ocultar(carpetaParaInicializar)) }] : []),
      { value: "salir", label: "Salir" },
    ];
    return [
      { value: "agentes", label: "Agentes" },
      { value: "diagnostico", label: "Diagnóstico" },
      { value: "adaptador", label: "Adaptadores", description: adaptadorVisible() },
      { value: "alcance", label: "Alcance", description: resumenAlcance() },
      { value: "ajustes", label: "Modelo y ajustes", description: llmProyecto().modelo ?? "Pendiente" },
      { value: "auditoria", label: "Auditoría" },
      { value: "sesiones", label: "Sesiones de trabajo", description: sesion },
      { value: "proyectos", label: "Proyectos" },
      { value: "salir", label: "Salir" },
    ].map((opcion) => ({ ...opcion, description: opcion.description && seguro(ocultar(opcion.description)) }));
  }

  function resumenPantalla() {
    if (agente) return [
      (agente.autonoma || agente.modo === "demo") && "Simulado",
      agente.historialPendiente ? "Cargando historial" : estadoAgente(agente),
      agente.soloConsulta && "Solo consulta",
      agente.modelId,
    ].filter(Boolean).join(" | ");
    const activos = [...agentes.values()].filter((item) => item.trabajo || envios.has(item)).length;
    return [
      activos ? `${activos} ${activos === 1 ? "agente" : "agentes"} trabajando` : "",
      controlWifi?.preflight?.ok === false ? "Preflight bloqueado" : "",
    ].filter(Boolean).join(" | ");
  }

  function actualizar() {
    interfaz?.render({
      proyecto: carpetaTrabajo ? seguro(ocultar(basename(carpetaTrabajo))) : undefined, rutaProyecto: proyecto, cliente: config?.cliente === "demo" ? undefined : config?.cliente,
      agente: agente?.id, agentes: [...agentes.values()].filter((item) => item.iniciado),
      mensajes: agente?.autonoma ? agente.avisos ?? [] : agente ? agente.mensajes : mensajes,
      transcript: agente?.transcript, ...(config && llmProyecto()),
      autonoma: agente?.autonoma, soloConsulta: agente?.soloConsulta, comandos: disponibles(proyecto, agente),
      controlWifi, menu: menuPrincipal(), estadoResumen: seguro(ocultar(resumenPantalla())),
      actividad: actividadAgente(agente),
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
  function mostrarError(error, destino = agente) {
    const mensaje = "Error: " + error.message;
    if (tty) {
      mostrar(mensaje, destino);
      if (!destino) interfaz?.notificar(mensaje.replace(" con /alcance set", ""));
    }
    else {
      console.error(seguro(ocultar(mensaje)));
      process.exitCode = 1;
    }
  }
  function volver() {
    agente = undefined;
    actualizar();
  }
  function cerrar() {
    if (cerrando) return;
    cerrando = true;
    diagnosticoPendiente?.abort();
    inspeccionPendiente?.abort();
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
    try {
      carpetaParaInicializar = await abrirProyectoInicial();
    } catch (error) {
      mostrarError(error);
    }
    if (tty && !cerrando) {
      const { pantalla } = await import("./pantalla.mjs");
      interfaz = pantalla(comandos, { salir: cerrar, volver, ocultar, limpiar: (texto) => seguro(ocultar(texto)),
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
      if (mensajes.some((mensaje) => mensaje.startsWith("Aviso: no se pudo leer la sesión"))) {
        interfaz.notificar("Algunas sesiones guardadas son ilegibles.");
      }
      const errorInicial = mensajes.find((mensaje) => mensaje.startsWith("Error:"));
      if (errorInicial) interfaz.notificar(errorInicial);
      if (carpetaParaInicializar && destino) {
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
      if (typeof entrada === "object") {
        try {
          await navegar(entrada.accion);
        } catch (error) {
          mostrarError(error);
        }
        continue;
      }
      const texto = ocultar(entrada.trim());
      if (!texto) continue;
      if (tty && (texto.startsWith("/") || texto === "ls" || /^agent\s+harwiff(?:\s|$)/.test(texto))) {
        mostrar(`${agente ? "Tú" : NOMBRE_ENTORNO}  ${texto}`);
      }
      try {
        await procesar(texto);
      } catch (error) {
        mostrarError(error);
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
      const verificacion = `OpenAI Responses y function calling verificados · ${resultado.modeloDevuelto ?? resultado.modelId} · ${resultado.herramienta}`;
      mostrar(verificacion);
      const { tokens } = resultado;
      const consumo = tokens ? `Tokens de conectividad · entrada ${tokens.entrada}, salida ${tokens.salida}, total ${tokens.total}`
                : "OpenAI no informó tokens para la prueba de conectividad.";
      mostrar(consumo);
      return verificacion + "\n" + consumo;
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
    if (!interfaz.enComandos() && !process.env.FOUNDRY_API_KEY) {
      return interfaz.mostrarDetalle("Define FOUNDRY_API_KEY en el entorno desde el que ejecutas Harwiff.",
        "Falta la credencial de Azure AI Foundry");
    }
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
    const texto = `Azure AI Foundry · function calling verificado · ${modelo.modelo.id}`;
    mostrar(texto);
    return texto;
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
    if (opcion === "credencial") {
      const texto = "Azure AI Foundry usa FOUNDRY_API_KEY del entorno.";
      if (interfaz.enComandos()) mostrar(texto);
      else await interfaz.mostrarDetalle(texto, "Origen de la credencial");
    }
    if (opcion === "probar") await mostrarPruebaConexion(probarFoundry);
    if (opcion === "desconectar") {
      await actualizarConfig((actual) => {
        const { foundry, ...resto } = actual;
        return { ...resto, llm: { ...resto.llm,
          proveedor: proveedorAgente(actual) === "azure-foundry" ? null : proveedorAgente(actual) } };
      });
      mostrar("Azure AI Foundry desvinculado del proyecto.");
    }
  }

  async function mostrarPruebaConexion(probar) {
    if (interfaz.enComandos()) return probar();
    const resultado = await interfaz.consultar("Probando conexión con el proveedor…", probar, { cancelable: false });
    if (resultado) await interfaz.mostrarDetalle(resultado, "Conexión verificada");
  }

  async function conectarOpenAI() {
    const entrada = await interfaz.preguntarSecreto("API key de OpenAI · entrada oculta · Esc cancela >");
    if (!entrada || cerrando) return;
    const entorno = credenciales.conClave(entrada);
    const ids = interfaz.enComandos() ? await listarModelosOpenAI({ entorno }) :
      await interfaz.consultar("Verificando la credencial…", () => listarModelosOpenAI({ entorno }), { cancelable: false });
    if (cerrando) return;
    const fuente = await credenciales.guardar(entrada);
    verificaciones.clear();
    mostrar("OpenAI API conectado · Credencial: " + fuente);
    if (fuente === "memoria de Harwiff") {
      mostrar("Secret Service no disponible. La clave se elimina al cerrar Harwiff.");
      interfaz.notificar("Credencial en memoria hasta cerrar Harwiff");
    } else interfaz.notificar("Credencial guardada en " + fuente);
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
          ids ??= interfaz && !interfaz.enComandos()
            ? await interfaz.consultar("Cargando catálogo de modelos…", () => listarModelosOpenAI(conexion), { cancelable: false })
            : await listarModelosOpenAI(conexion);
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
      if (errorOpenAI) {
        mostrar("OpenAI · " + errorOpenAI.message);
        if (interfaz && !interfaz.enComandos()) interfaz.notificar("Catálogo parcial · " + errorOpenAI.message);
      }
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
    if (opcion === "probar") return mostrarPruebaConexion(() => probarOpenAI(id, conexion));
    if (opcion === "desconectar") {
      await desvincularOpenAI();
      interfaz.notificar("Credencial de OpenAI desvinculada");
    }
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
    if (hayTrabajo()) {
      throw new Error(interfaz && !interfaz.enComandos()
        ? "Hay trabajo en curso. Espera a que termine o detén el turno desde las acciones del agente."
        : "Espera a que termine el agente o usa /detener antes de cambiar de proyecto.");
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
    const nuevoControl = await leerControlWifi(ubicacion);

    const nuevaCarpetaAgentes = join(raiz, "agentes");
    const nuevosAgentes = new Map();
    const avisosSesiones = [];
    for (const id of await directorios(nuevaCarpetaAgentes)) {
      if (!ID_SESION.test(id)) continue;
      try {
        const item = await cargarAgente(nuevaCarpetaAgentes, id, { soloResumen: true });
        if (item) nuevosAgentes.set(id, item);
      } catch {
        avisosSesiones.push("Aviso: no se pudo leer la sesión " + id + ".");
      }
    }
    const actividad = await leerActividadProyecto(raiz);
    if (cerrando) return;
    carpetaTrabajo = fisica;
    proyecto = raiz;
    ruta = archivo;
    config = nuevaConfig;
    controlWifi = nuevoControl;
    adaptadorAusente = undefined;
    agentesDir = nuevaCarpetaAgentes;
    agentes = nuevosAgentes;
    sesion = undefined;
    agente = undefined;
    mensajes = [];
    mostrar((creado ? "Proyecto creado" : "Proyecto abierto") + " · " + carpetaTrabajo);
    if (creado) interfaz?.notificar("Proyecto creado");
    if (creado) mostrar("Datos de Harwiff guardados en .harwiff/.");
    if (!tty) {
      const { proveedor, modelo } = llmProyecto();
      mostrar(["Proveedor LLM", proveedor, ...(modelo ? ["Modelo predeterminado " + modelo] : [])].join(" · "));
      mostrar(resumenControlWifi(controlWifi));
      for (const item of agentes.values()) {
        if (item.iniciado) mostrar(`Agente ${item.id} · ${item.estado}`);
      }
    }
    for (const aviso of avisosSesiones) {
      if (tty) mostrar(aviso);
      else console.error(seguro(aviso));
    }
    if (avisosSesiones.length) interfaz?.notificar("Algunas sesiones guardadas son ilegibles.");
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

  async function ejecutarInspeccion(opciones, cancelacion) {
    if (inspeccionPendiente) throw new Error("Ya hay una inspección en curso.");
    const controlador = new AbortController();
    inspeccionPendiente = controlador;
    try {
      config = await leerJson(ruta);
      const proveedor = process.env.HARWIFF_LLM_PROVIDER ?? config.llm?.inspeccion?.provider ?? config.llm?.proveedor;
      const conexionOpenAI = proveedor === "openai" ? await credenciales.resolver() : undefined;
      const conexion = await resolverModeloInspeccion(config, conexionOpenAI?.entorno);
      const signal = cancelacion ? AbortSignal.any([controlador.signal, cancelacion]) : controlador.signal;
      return await inspeccionar({proyecto: proyectoWifi(), ...opciones, conexion, signal});
    } finally {
      inspeccionPendiente = undefined;
    }
  }

  async function menuInspeccion() {
    const perfil = await entorno("adaptadores-perfil", undefined, {tiempo: 15000, soloLectura: true});
    const nombres = [...new Set(perfil.devices.flatMap(d => d.phys.flatMap(p => p.interfaces.map(i => i.ifname))))];
    const valor = await interfaz.elegir("Inspección de solo lectura", [
      {value: "host", label: "Inventario del host"},
      ...nombres.map(value => ({value: "if:" + value, label: value})),
    ], undefined, {id: "inspeccion-interfaz"});
    if (!valor) return;
    const nombre = valor.startsWith("if:") ? valor.slice(3) : undefined;
    const control = nombre ? await leerControlWifi(proyectoWifi()) : null;
    let red = false;
    if (control && (control.scope.allowedSsids.length || control.scope.allowedBssids.length)) {
      const permiso = await interfaz.elegir("Alcance de la inspección", [
        {value: "host", label: "Solo datos del host"},
        {value: "red", label: "Incluir la asociación autorizada del proyecto"},
      ], undefined, {id: "inspeccion-alcance"});
      if (!permiso) return;
      red = permiso === "red";
    }
    let anterior;
    while (!cerrando) {
      const objetivo = (await interfaz.preguntar(anterior ? "¿Qué quieres revisar a continuación?" : "¿Qué quieres revisar?"))?.trim();
      if (!objetivo) return;
      const resultado = await interfaz.consultar("Inspección Wi-Fi de solo lectura…",
        signal => ejecutarInspeccion({objetivo, anterior, nombre, red, historial: true}, signal));
      if (!resultado || cerrando) return;
      await interfaz.mostrarDetalle(textoInspeccion(resultado), "Inspección Wi-Fi");
      const siguiente = await interfaz.elegir("Inspección", [
        {value: "otra", label: "Hacer otra pregunta"},
        {value: "volver", label: "Volver a Agentes"},
      ], undefined, {id: "inspeccion-continuar"});
      if (siguiente !== "otra") return;
      anterior = {objetivo, scopeId: resultado.scopeId};
    }
  }

  function textoInspeccion(resultado) {
    return ["Inspección " + resultado.motivo + " · /auditoria " + resultado.turnId, ...resultado.lineas].join("\n");
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
      if (item.estado !== "completed") throw new Error(item.actividad || "La sesión no se completó.");
    }
    return item;
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
      const mensaje = control.signal.aborted ? "Turno detenido." : "Turno interrumpido. " + error.message;
      if (tty) mostrar(mensaje, item);
      else mostrarError(new Error(mensaje), item);
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

  async function detalleOperacion(id = "") {
    const item = agente;
    await cargarHistorialAgente(item);
    if (agente !== item) return;
    const modoMenu = interfaz && !interfaz.enComandos() && !id;
    do {
      const opciones = item.operaciones;
      const auditadas = opciones.filter(({ auditId }) => auditId);
      if (modoMenu) {
        if (!opciones.length) return interfaz.mostrarDetalle("Todavía no hay operaciones.", "Operaciones");
        id = await interfaz.elegir("Detalles de operaciones", () => actividadAgente(item), undefined, { id: "operaciones" });
      } else {
        if (!auditadas.length) throw new Error("Todavía no hay operaciones con auditoría en esta sesión.");
        id ||= interfaz && await interfaz.elegir("Detalles de operaciones", auditadas.map(({ tool, auditId, autorizacion }) => ({
          value: auditId, label: tool, description: (autorizacion?.decision ?? "") + " · " + auditId,
        })));
      }
      if (!id) return;
      const operacion = item.operaciones.find(({ auditId, llamadaId }) => auditId === id || llamadaId === id);
      if (!operacion) throw new Error("Ese ID no corresponde a una operación de esta sesión.");
      if (!operacion.auditId && modoMenu) {
        await interfaz.mostrarDetalle(operacion.tool + " · En curso. El registro estará disponible al terminar.", "Operación");
        continue;
      }
      if (!operacion.auditId) throw new Error("Ese ID no corresponde a una operación auditada.");
      const registro = await leerAuditoria(proyecto, operacion.auditId);
      const detalle = seguro(ocultar([
        "Herramienta · " + operacion.tool + " · " + registro.autorizacion?.decision + " · " + registro.autorizacion?.motivo,
        "Parámetros · " + JSON.stringify(operacion.parametros ?? registro.parametrosNormalizados ?? {}),
        "Auditoría · " + operacion.auditId,
        "Resultado · " + JSON.stringify(operacion.result),
        "Evidencias · " + JSON.stringify(registro.referenciasEvidencia ?? []),
      ].join("\n")));
      if (interfaz) await interfaz.mostrarDetalle(detalle);
      else mostrar(detalle);
    } while (modoMenu);
  }

  async function ejecutarDiagnostico(demo, cancelacion, seleccion) {
    const actual = demo ? undefined : await leerControlWifi(proyectoWifi());
    const adaptador = actual?.adapter;
    if (seleccion && (adaptador?.id !== seleccion.id || actual.revision !== seleccion.revision)) {
      throw new Error("El adaptador o el alcance cambiaron. Reabre Diagnóstico para confirmar la selección actual.");
    }
    const esDemo = demo || adaptador?.id === "mock";
    diagnosticoPendiente = new AbortController();
    const signal = cancelacion ? AbortSignal.any([diagnosticoPendiente.signal, cancelacion]) : diagnosticoPendiente.signal;
    if (!interfaz || interfaz.enComandos()) mostrar(esDemo ? "Preparando muestra sintética…" : "Ejecutando diagnóstico en OpenSandbox…");
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
      if (!interfaz || interfaz.enComandos()) mostrar(`Informe guardado: informes/${id}.json · /auditoria ${id}`);
      return id;
    } finally {
      diagnosticoPendiente = undefined;
    }
  }

  async function confirmarSalida() {
    if (!hayTrabajo() || await interfaz.elegir("Hay trabajo en curso. Salir cancela las operaciones activas.", [
      { value: "seguir", label: "Seguir en Harwiff" },
      { value: "salir", label: "Cancelar trabajo y salir" },
    ]) === "salir") cerrar();
  }

  async function ayudaMenu() {
    const opcion = await interfaz.elegir("Ayuda", [
      { value: "teclado", label: "Teclado" },
      { value: "comandos", label: "Consola de comandos" },
    ]);
    if (opcion === "teclado") await interfaz.mostrarDetalle([
      "Flechas · mover el foco o recorrer un detalle",
      "Enter · abrir, confirmar o enviar",
      "Esc · volver al nivel anterior",
      "Tab · abrir las acciones de la conversación",
      "Ctrl+J · nueva línea en un campo de texto",
      "Re Pág / Av Pág · recorrer el historial",
      "Ctrl+Fin · seguir las respuestas nuevas",
      "Ctrl+C · cancelar un diálogo o solicitar la salida",
    ].join("\n"), "Teclado");
    if (opcion === "comandos") interfaz.comandos();
  }

  async function explorarProyectos() {
    let base = carpetaTrabajo ? dirname(carpetaTrabajo) : carpetaInicial;
    let profundidad = 1;
    for (;;) {
      const resultado = await interfaz.consultar("Buscando proyectos…", () => descubrirProyectos(base, profundidad));
      if (!resultado) return;
      const opciones = resultado.proyectos.map(({ ruta, nombre }) => ({
        value: ruta, label: nombre, description: ruta === carpetaTrabajo ? "Proyecto actual" : ruta,
      }));
      const titulo = ["Abrir proyecto / " + resultado.ruta, !opciones.length && "No hay proyectos en esta carpeta.",
        resultado.avisos.length && resultado.avisos.length + " avisos de lectura."].filter(Boolean).join("\n");
      const opcion = await interfaz.elegir(titulo, [
        ...opciones, { value: "ruta", label: "Buscar en otra carpeta" },
        ...(resultado.avisos.length ? [{ value: "avisos", label: "Ver avisos" }] : []),
      ], carpetaTrabajo, { id: "abrir-proyecto" });
      if (!opcion) return;
      if (opcion === "avisos") {
        await interfaz.mostrarDetalle(resultado.avisos.map(({ ruta, motivo }) => ruta + " · " + motivo).join("\n"), "Avisos de lectura");
        continue;
      }
      if (opcion === "ruta") {
        const datos = await interfaz.formulario("Buscar proyectos", [
          { id: "ruta", label: "Carpeta" },
          { id: "profundidad", label: "Profundidad", ayuda: "Profundidad de búsqueda, de 0 a 5" },
        ], { ruta: base, profundidad: String(profundidad) });
        if (datos) {
          if (!datos.ruta.trim() || !/^[0-5]$/.test(datos.profundidad.trim())) {
            interfaz.notificar("Indica una carpeta y una profundidad de 0 a 5.");
            continue;
          }
          base = resolverCarpeta(datos.ruta.trim());
          profundidad = Number(datos.profundidad);
        }
        continue;
      }
      await seleccionarProyecto(opcion, { soloAbrir: true });
      return;
    }
  }

  async function crearProyectoMenu() {
    const carpeta = await interfaz.preguntar("Carpeta del proyecto", esRaiz(carpetaInicial) ? "" : carpetaInicial);
    if (!carpeta?.trim()) return;
    const cliente = await interfaz.elegir("Crear o abrir proyecto", [
      { value: "demo", label: "Proyecto local" },
      { value: "azure-foundry", label: "Proyecto Azure Foundry" },
    ]);
    if (cliente) await seleccionarProyecto(resolverCarpeta(carpeta.trim()), { cliente });
  }

  async function menuProyectos() {
    for (;;) {
      const antes = proyecto;
      const opcion = await interfaz.elegir("Proyectos", [
        { value: "abrir", label: "Abrir proyecto" },
        { value: "crear", label: "Crear proyecto" },
      ], undefined, { id: "proyectos" });
      if (!opcion) return;
      try {
        if (opcion === "abrir") await explorarProyectos();
        if (opcion === "crear") await crearProyectoMenu();
        if (antes !== proyecto) return;
      } catch (error) {
        mostrarError(error);
      }
    }
  }

  async function elegirAdaptador() {
    controlWifi = await leerControlWifi(proyectoWifi());
    actualizar();
    const guardado = controlWifi.adapter;
    await panelAdaptadores(interfaz, seguro(guardado?.name ?? (guardado ? "adaptador guardado" : "ninguno")), async (name, id, observado) => {
      try {
        controlWifi = await usarAdaptador(proyectoWifi(), name, id, observado);
      } catch (error) {
        if (guardado?.id === id && error.code === "adapter_disconnected") {
          adaptadorAusente = id;
          actualizar();
        }
        throw error;
      }
      adaptadorAusente = undefined;
      mostrar("Adaptador seleccionado: " + controlWifi.adapter.name + " · Preflight: OK");
      interfaz.notificar("Adaptador seleccionado · Preflight correcto");
    }, {
      alLeer(perfil) {
        if (!guardado || guardado.id === "mock") return;
        const presente = perfil.devices.some(({ phys }) => phys.some(({ interfaces }) =>
          interfaces.some(({ legacyAdapterId, ifname }) => legacyAdapterId === guardado.id && (!guardado.name || ifname === guardado.name))));
        if (presente || perfil.status === "complete") adaptadorAusente = presente ? undefined : guardado.id;
        actualizar();
        return presente ? "" : perfil.status === "complete" ? " · desconectado" : " · presencia sin confirmar";
      },
    });
  }

  async function editarAlcance() {
    const scope = controlWifi.scope;
    let valores = {
      ssids: scope?.allowedSsids.join("\n") ?? "",
      bssids: scope?.allowedBssids.join("\n") ?? "",
      canales: scope?.allowedChannels.join(", ") ?? "",
    };
    for (;;) {
      valores = await interfaz.formulario("Editar alcance autorizado", [
        { id: "ssids", label: "SSID", ayuda: "SSID autorizados · uno por línea · Ctrl+J añade una línea" },
        { id: "bssids", label: "BSSID", ayuda: "BSSID autorizados · uno por línea · Ctrl+J añade una línea" },
        { id: "canales", label: "Canales", ayuda: "Canales permitidos · separados por comas" },
      ], valores);
      if (!valores) return;
      try {
        const canales = valores.canales.trim();
        if (canales && !/^\d+(?:\s*,\s*\d+)*$/.test(canales)) throw new Error("Separa los números de canal con comas.");
        controlWifi = await guardarAlcance(proyectoWifi(), {
          allowedSsids: valores.ssids.split("\n").filter(Boolean),
          allowedBssids: valores.bssids.split(/\r?\n/).map((texto) => texto.trim()).filter(Boolean),
          allowedChannels: canales ? canales.split(",").map(Number) : [],
        });
        interfaz.notificar(controlWifi.preflight?.ok === false ? "Alcance guardado · Preflight bloqueado" : "Alcance guardado");
        actualizar();
        return;
      } catch (error) {
        mostrarError(error);
      }
    }
  }

  async function menuAlcance() {
    controlWifi = await leerControlWifi(proyectoWifi());
    for (;;) {
      const opcion = await interfaz.elegir("Alcance autorizado · " + resumenAlcance(), [
        { value: "editar", label: "Editar alcance" },
        { value: "detalle", label: "Ver valores guardados" },
        { value: "revisar", label: "Comprobar preflight" },
      ], undefined, { id: "alcance" });
      if (!opcion) return;
      if (opcion === "editar") await editarAlcance();
      if (opcion === "detalle") {
        const scope = controlWifi.scope;
        await interfaz.mostrarDetalle(tieneAlcance() ? [
          "SSID · " + (scope.allowedSsids.join(", ") || "Sin filtro"),
          "BSSID · " + (scope.allowedBssids.join(", ") || "Sin filtro"),
          "Canales · " + (scope.allowedChannels.join(", ") || "Sin filtro"),
        ].join("\n") : "Define los SSID o BSSID autorizados en Editar alcance.", "Alcance autorizado");
      }
      if (opcion === "revisar") {
        const resultado = await interfaz.consultar("Comprobando preflight…", () => inspeccionarControlWifi(proyectoWifi()),
          { cancelable: false });
        if (!resultado) return;
        controlWifi = resultado.estado;
        actualizar();
        const verificacion = controlWifi.preflight;
        await interfaz.mostrarDetalle(verificacion?.ok ? "Preflight correcto" :
          verificacion?.errors?.join("\n") || "Selecciona un adaptador en Adaptadores.", "Preflight");
      }
    }
  }

  async function menuDiagnostico() {
    controlWifi = await leerControlWifi(proyectoWifi());
    const adaptador = controlWifi.adapter;
    const revision = controlWifi.revision;
    const opciones = [
      ...(adaptador ? [{ value: "actual", label: adaptador.id === "mock" ? "Ejecutar en modo simulado" : "Ejecutar en modo físico",
        description: adaptadorVisible() }] : [{ value: "adaptador", label: "Elegir adaptador" }]),
      { value: "demo", label: "Generar muestra sintética" },
    ];
    const modo = await interfaz.elegir("Diagnóstico", opciones, undefined, { id: "diagnostico" });
    if (!modo) return;
    if (modo === "adaptador") return elegirAdaptador();
    const simulado = modo === "demo" || adaptador?.id === "mock";
    const id = await interfaz.consultar(simulado ? "Generando muestra sintética…" : "Ejecutando diagnóstico físico en OpenSandbox…",
      (signal) => ejecutarDiagnostico(modo === "demo", signal, modo === "actual" ? { id: adaptador.id, revision } : undefined));
    if (!id) {
      if (!cerrando) interfaz.notificar("Diagnóstico cancelado");
      return;
    }
    interfaz.notificar("Informe guardado");
    const opcion = await interfaz.elegir("Informe guardado", [{ value: "auditoria", label: "Ver en Auditoría" }]);
    if (opcion) await detalleAuditoria(id);
  }

  async function detalleAuditoria(id) {
    const registro = await leerAuditoria(proyecto, id);
    const resumen = [
      "Operación · " + registro.operacion, "Resultado · " + registro.estado, "Fecha · " + registro.inicio, "ID · " + id,
      registro.motor && "Motor · " + registro.motor,
      registro.motivo && "Motivo · " + registro.motivo,
      registro.evidencia && "Evidencia · " + JSON.stringify(registro.evidencia, null, 2),
    ].filter(Boolean).join("\n");
    const opciones = [
      { value: "resumen", label: "Ver resumen", description: registro.estado },
      { value: "json", label: "Ver registro JSON" },
    ];
    for (;;) {
      const opcion = await interfaz.elegir("Auditoría / " + registro.operacion, opciones, undefined, { id: "auditoria/" + id });
      if (!opcion) return;
      await interfaz.mostrarDetalle(opcion === "json" ? JSON.stringify(registro, null, 2) : resumen,
        opcion === "json" ? "Registro JSON" : "Resumen de auditoría");
    }
  }

  async function menuAuditoria() {
    const ids = (await idsAuditoria(proyecto)).reverse();
    if (!ids.length) return interfaz.mostrarDetalle("Aquí aparecerán diagnósticos, turnos y cambios de configuración.", "Sin registros de auditoría");
    const registros = [];
    for (;;) {
      registros.push(...await Promise.all(ids.slice(registros.length, registros.length + 30).map(async (id) => {
        try {
          const registro = await leerAuditoria(proyecto, id);
          return { value: id, label: registro.operacion, description: registro.estado + " · " + registro.inicio.slice(0, 16).replace("T", " ") + " UTC" };
        } catch {
          return { value: id, label: "Registro ilegible", description: id };
        }
      })));
      for (;;) {
        const opcion = await interfaz.elegir("Auditoría", [
          ...registros, ...(registros.length < ids.length ? [{ value: "anteriores", label: "Cargar anteriores" }] : []),
        ], undefined, { id: "auditoria" });
        if (!opcion) return;
        if (opcion === "anteriores") break;
        try {
          await detalleAuditoria(opcion);
        } catch (error) {
          mostrarError(error);
        }
      }
    }
  }

  async function guardarPuertoSandbox(valor) {
    const puerto = valor === "auto" ? 0 : Number(valor);
    if (valor !== "auto" && !(Number.isInteger(puerto) && puerto >= 1024 && puerto <= 65535)) {
      throw new Error(interfaz && !interfaz.enComandos() ? "Elige Automático o un puerto entre 1024 y 65535." :
        "Usa /config sandbox auto o /config sandbox <puerto entre 1024 y 65535>.");
    }
    await actualizarConfig((actual) => ({ ...actual, puertoSandbox: puerto }));
  }

  async function editarSandbox() {
    const opcion = await interfaz.elegir("Puerto local de OpenSandbox", [
      { value: "auto", label: "Automático" },
      { value: "fijo", label: "Puerto fijo" },
    ], config.puertoSandbox ? "fijo" : "auto");
    if (!opcion) return;
    const puerto = opcion === "auto" ? "auto" : await interfaz.preguntar("Puerto entre 1024 y 65535", String(config.puertoSandbox || ""));
    if (puerto === undefined) return;
    await guardarPuertoSandbox(puerto.trim());
    interfaz.notificar("Configuración de OpenSandbox guardada");
  }

  async function menuAjustes() {
    for (;;) {
      config = await leerJson(ruta);
      const { proveedor, modelo } = llmProyecto();
      const opcion = await interfaz.elegir("Modelo y ajustes", [
        { value: "modelo", label: "Modelo para sesiones nuevas", description: modelo ?? "Pendiente" },
        { value: "proveedor", label: "Conexiones de proveedor", description: proveedor },
        { value: "sandbox", label: "Puerto de OpenSandbox", description: String(config.puertoSandbox || "Automático") },
      ], undefined, { id: "ajustes" });
      if (!opcion) return;
      try {
        if (opcion === "modelo") {
          const conexion = await credenciales.resolver();
          let foundry = false;
          try { foundry = Boolean(modeloFoundry(config)); } catch { /* Sin deployment disponible. */ }
          if (!conexion.fuente && !foundry) {
            interfaz.notificar("Conecta un proveedor para elegir modelo.");
            await conectarProveedor();
          } else await elegirModelo("", { conexion });
        }
        if (opcion === "proveedor") await conectarProveedor();
        if (opcion === "sandbox") await editarSandbox();
      } catch (error) {
        mostrarError(error);
      }
    }
  }

  async function menuSesiones() {
    const carpeta = join(proyecto, "sesiones");
    for (;;) {
      const directorio = await lstat(carpeta).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      if (directorio && !directorio.isDirectory()) throw new Error("La carpeta de sesiones de trabajo no es válida.");
      const ids = directorio ? (await app("sesiones")).split("\n").filter(Boolean) : [];
      const opcion = await interfaz.elegir(ids.length ? "Sesiones de trabajo" : "Sesiones de trabajo · sin sesiones", [
        { value: "+nueva", label: "Crear sesión de trabajo" },
        { value: "+contexto", label: "Consultar contexto del proyecto" },
        ...ids.map((id) => ({ value: id, label: id, description: id === sesion ? "Abierta" : undefined })),
      ], sesion, { id: "sesiones" });
      if (!opcion) return;
      if (opcion === "+contexto") {
        const informes = await informesAgente(proyecto);
        await interfaz.mostrarDetalle(informes.length ? JSON.stringify(informes, null, 2) : "Todavía no hay informes.", "Contexto del proyecto");
        continue;
      }
      if (opcion === "+nueva") {
        const datos = await interfaz.formulario("Crear sesión de trabajo", [
          { id: "nombre", label: "Nombre" }, { id: "objetivo", label: "Objetivo" },
        ], { nombre: "", objetivo: "Revisar la conectividad Wi-Fi" });
        if (!datos) continue;
        if (!ID_SESION.test(datos.nombre)) {
          interfaz.notificar("Usa de 1 a 64 letras minúsculas, números, guiones o guiones bajos.");
          continue;
        }
        if (!directorio) {
          await mkdir(carpeta, { mode: 0o700 }).catch((error) => {
            if (error.code !== "EEXIST") throw error;
          });
          if (!(await lstat(carpeta)).isDirectory()) throw new Error("La carpeta de sesiones de trabajo no es válida.");
        }
        await app("nueva", datos.nombre, "--objetivo", datos.objetivo || "Revisar la conectividad Wi-Fi");
        sesion = datos.nombre;
      } else {
        await app("abrir", opcion);
        sesion = opcion;
      }
      actualizar();
      for (;;) {
        const accion = await interfaz.elegir("Sesión de trabajo / " + sesion, [
          { value: "contexto", label: "Consultar contexto" }, { value: "nota", label: "Guardar nota" },
        ], undefined, { id: "sesion-trabajo" });
        if (!accion) break;
        if (accion === "contexto") await interfaz.mostrarDetalle(await app("abrir", sesion), "Notas e informes");
        if (accion === "nota") {
          const nota = await interfaz.preguntar("Nota de trabajo · Ctrl+J añade una línea");
          if (nota?.trim()) {
            await ejecutar("app.py", ["--proyecto", proyecto, "guardar", sesion], { entrada: nota.trim() });
            interfaz.notificar("Nota guardada");
          }
        }
      }
    }
  }

  async function nuevoAgente() {
    const dir = proyecto;
    const texto = await interfaz.preguntar("¿Qué quieres revisar con el agente?", objetivosPendientes.get(dir), {
      alCancelar(borrador) {
        if (borrador.trim()) objetivosPendientes.set(dir, borrador);
        else objetivosPendientes.delete(dir);
      },
    });
    if (texto === undefined) return;
    const objetivo = texto.trim();
    if (!objetivo) return;
    objetivosPendientes.set(dir, objetivo);
    controlWifi = await leerControlWifi(proyectoWifi());
    config = await leerJson(ruta);
    const proveedor = proveedorAgente(config);
    const conexion = proveedor === "azure-foundry" ? undefined : await credenciales.resolver();
    let configurado = Boolean(conexion?.fuente);
    if (proveedor !== "openai" && !configurado) {
      try { configurado = Boolean(modeloFoundry(config)); } catch { /* Requiere conexión. */ }
    }
    const falta = !tieneAlcance() ? ["Define el alcance autorizado", "Editar alcance", menuAlcance] :
      controlWifi.adapter?.id !== "mock" ? ["La conversación usa el escenario simulado", "Elegir adaptador mock", elegirAdaptador] :
        !configurado ? ["Falta conectar un proveedor", "Abrir modelo y ajustes", menuAjustes] : undefined;
    if (falta) {
      const [motivo, label, abrir] = falta;
      const opcion = await interfaz.elegir(motivo, [{ value: "configurar", label }, { value: "volver", label: "Volver" }]);
      if (opcion === "configurar") await abrir();
      interfaz.notificar("Borrador conservado en Nueva conversación");
      return;
    }
    const item = await iniciarAgenteProyecto(objetivo, true);
    if (item) objetivosPendientes.delete(dir);
  }

  async function menuAgentes() {
    for (;;) {
      const haySesiones = [...agentes.values()].some(({ iniciado }) => iniciado);
      const opcion = await interfaz.elegir(haySesiones ? "Agentes" : "Agentes · sin conversaciones", () => [
        { value: "+nueva", label: "Nueva conversación", description: objetivosPendientes.has(proyecto) ? "Borrador guardado" : undefined },
        ...[...agentes.values()].filter(({ iniciado }) => iniciado)
          .sort((a, b) => (b.uso ?? "").localeCompare(a.uso ?? ""))
          .map((item) => ({ value: item.id, label: item.objetivo || item.id, description: estadoAgente(item) })),
        { value: "+inspeccion", label: "Inspección Wi-Fi de solo lectura" },
      ], undefined, { id: "agentes" });
      if (!opcion) return;
      try {
        if (opcion === "+inspeccion") await menuInspeccion();
        else if (opcion === "+nueva") await nuevoAgente();
        else await enfocar(opcion);
        if (agente) return;
      } catch (error) {
        mostrarError(error);
        if (agente) return;
      }
    }
  }

  async function detalleTurnos() {
    await cargarHistorialAgente(agente);
    const turnos = new Map();
    for (const bloque of agente.transcript ?? []) {
      if (bloque.tipo !== "detalle" || !bloque.turno) continue;
      if (!turnos.has(bloque.turno)) turnos.set(bloque.turno, []);
      turnos.get(bloque.turno).push(bloque.text);
    }
    if (!turnos.size) return interfaz.mostrarDetalle("Todavía no hay turnos registrados.", "Detalle de turnos");
    for (;;) {
      const turno = await interfaz.elegir("Detalle de turnos", [...turnos.keys()].reverse().map((value) => ({
        value, label: new Date(Number(value.split("-")[0])).toISOString().slice(0, 19).replace("T", " ") + " UTC",
      })), undefined, { id: "turnos" });
      if (!turno) return;
      await interfaz.mostrarDetalle(turno + "\n\n" + turnos.get(turno).join("\n"), "Detalle del turno");
    }
  }

  async function menuAccionesAgente() {
    for (;;) {
      const opcion = await interfaz.elegir("Acciones del agente", () => [
        { value: "operaciones", label: "Operaciones", description: String(agente.operaciones?.length ?? 0) },
        { value: "turnos", label: "Detalle de turnos" },
        ...(agente.controlador ? [{ value: "detener", label: "Detener turno" }] : []),
        { value: "volver", label: "Volver a Agentes" },
        { value: "ayuda", label: "Ayuda" },
      ], undefined, { id: "acciones-agente" });
      if (!opcion) return;
      if (opcion === "operaciones") await detalleOperacion();
      if (opcion === "turnos") await detalleTurnos();
      if (opcion === "detener") {
        agente.controlador?.abort();
        return;
      }
      if (opcion === "volver") {
        volver();
        return menuAgentes();
      }
      if (opcion === "ayuda") {
        await ayudaMenu();
        if (interfaz.enComandos()) return;
      }
    }
  }

  async function navegar(accion) {
    interfaz.notificar("");
    switch (accion) {
      case "salir": return confirmarSalida();
      case "ayuda": return ayudaMenu();
      case "abrirProyecto": return explorarProyectos();
      case "crearProyecto": return crearProyectoMenu();
      case "inicializar": return seleccionarProyecto(carpetaParaInicializar, { crearCarpeta: false });
      case "proyectos": return menuProyectos();
      case "agentes": return menuAgentes();
      case "accionesAgente": return menuAccionesAgente();
      case "regresarAgentes":
        volver();
        return menuAgentes();
      case "adaptador": return elegirAdaptador();
      case "alcance": return menuAlcance();
      case "diagnostico": return menuDiagnostico();
      case "ajustes": return menuAjustes();
      case "auditoria": return menuAuditoria();
      case "sesiones": return menuSesiones();
    }
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
          if (item.estado !== "completed") throw new Error(item.actividad || "La sesión no se completó.");
        }
      } else {
        await iniciarTurno(texto, item);
        if (!tty) await item.trabajo;
      }
      return;
    }
    if (agente?.autonoma && (texto === "/detalle" || texto.startsWith("/detalle "))) {
      return detalleOperacion(texto.slice("/detalle".length).trim());
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
    if (!proyecto) throw new Error("Usa /init para esta carpeta o /proyecto <ruta> para otra.");
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
        if (/^--inspeccion(?:\s|$)/.test(args)) {
          const opciones = interpretarInspeccion(args);
          const resultado = interfaz
            ? await interfaz.consultar("Inspección Wi-Fi de solo lectura…", signal => ejecutarInspeccion(opciones, signal))
            : await ejecutarInspeccion(opciones);
          if (resultado) mostrar(textoInspeccion(resultado), null);
        } else await iniciarAgenteProyecto(args);
        break;
      case "/adaptador": {
        if (!args && interfaz) return elegirAdaptador();
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
          if (extra) throw new Error("Usa /config sandbox auto o /config sandbox <puerto entre 1024 y 65535>.");
          await guardarPuertoSandbox(deployment);
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
      case "/diagnostico":
        if (args && args !== "demo") throw new Error("Usa /diagnostico [demo].");
        return ejecutarDiagnostico(args === "demo");
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
  } else if (destino === "--version" && !extra.length) console.log(await versionInstalada());
  else if (["--help", "-h"].includes(destino) && !extra.length) console.log(`Uso: harwiff [carpeta-del-proyecto]\n${USO_LISTADO}`);
  else if (extra.length || destino?.startsWith("-")) throw new Error("Uso: harwiff [carpeta-del-proyecto]");
  else await aplicar(destino);
} catch (error) {
  console.error(`Error: ${seguro(error.message)}`);
  process.exitCode = 1;
}
