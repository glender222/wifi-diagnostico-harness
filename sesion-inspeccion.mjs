import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { guardarJson, leerTurnos } from "./bucle.mjs";
import { conBloqueoProyecto } from "./entorno.mjs";
import { crearIdAuditoria, ID_EJECUCION, leerJson } from "./proyecto.mjs";

const ESQUEMA = "harwiff-conversacion-inspeccion/v1";
const LIMITE_VISTA = 100;
const textoVisible = (texto) => String(texto).replace(/\s+/g, " ").trim();

export async function crearConversacionInspeccion(raiz, adaptador) {
  const id = crearIdAuditoria();
  const dir = join(raiz, "agentes", id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const datos = { esquema: ESQUEMA, id, adaptador: adaptador ?? null, uso: new Date().toISOString() };
  await guardarJson(join(dir, "sesion.json"), datos);
  return cargarConversacionInspeccion(dir, datos);
}

export async function cargarConversacionInspeccion(dir, datos, { soloResumen = false } = {}) {
  if (datos?.esquema !== ESQUEMA) return;
  if (datos.id !== basename(dir) || !ID_EJECUCION.test(datos.id)) throw new Error("Conversación de inspección inválida.");
  if (datos.adaptador !== null && (typeof datos.adaptador?.id !== "string" || !/^[a-f0-9]{20}$/.test(datos.adaptador.id) ||
      typeof datos.adaptador.name !== "string" || !/^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,14}$/.test(datos.adaptador.name))) {
    throw new Error("La interfaz de la conversación guardada tiene un formato inválido.");
  }
  const turnos = soloResumen ? [] : await leerTurnos(dir, { limite: LIMITE_VISTA });
  const transcript = [];
  for (const turno of turnos) {
    if (typeof turno.usuario?.content !== "string") continue;
    const id = turno.id ?? `interrumpido-${transcript.length}`;
    transcript.push({ id: id + "/usuario", tipo: "mensaje", text: "Tú  " + turno.usuario.content });
    transcript.push({ id: id + "/respuesta", tipo: "mensaje",
      text: "Agente  " + (turno.respuesta ?? "Turno sin resultado guardado.") });
    if (turno.auditoria) transcript.push({ id: id + "/detalle", tipo: "detalle", turno: id, text: "/auditoria " + turno.auditoria });
  }
  return {
    id: datos.id, dir, inspeccion: true, autonoma: true, iniciado: true, modo: "inspeccion",
    adaptador: datos.adaptador, uso: datos.uso, objetivo: datos.objetivo ?? datos.adaptador?.name ?? "Inventario del host",
    estado: "lista", historialPendiente: soloResumen, transcript, operaciones: [],
    mensajes: transcript.filter(({ tipo }) => tipo === "mensaje").map(({ text }) => text),
  };
}

export async function guardarTurnoConversacion(item, texto, ejecutar, alRegistrar) {
  const mensaje = texto.trim();
  if (!mensaje || Buffer.byteLength(mensaje) > 2000) throw new Error("Escribe un mensaje de hasta 2.000 bytes.");
  return conBloqueoProyecto(item.dir, async () => {
    const datos = await leerJson(join(item.dir, "sesion.json"));
    const historial = await leerTurnos(item.dir, { limite: 3 });
    const id = crearIdAuditoria();
    const usuario = { role: "user", content: mensaje, timestamp: Date.now() };
    const dir = join(item.dir, "turnos", id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await guardarJson(join(dir, "inicio.json"), { usuario });
    alRegistrar({ id, usuario });
    await guardarJson(join(item.dir, "sesion.json"), {
      ...datos, objetivo: datos.objetivo || textoVisible(mensaje).slice(0, 110), uso: new Date().toISOString(),
    });
    const resultado = await ejecutar(historial);
    await guardarJson(join(dir, "resultado.json"), { id, usuario, ...resultado });
    return resultado;
  }, "Esta conversación tiene un turno abierto en otra consola.");
}
