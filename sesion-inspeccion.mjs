import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { guardarJson, leerTurnos } from "./bucle.mjs";
import { conBloqueoProyecto } from "./entorno.mjs";
import { crearIdAuditoria, ID_EJECUCION, leerJson } from "./proyecto.mjs";

const ESQUEMA = "harwiff-conversacion-inspeccion/v1";
const LIMITE_VISTA = 100;
const textoVisible = (texto) => String(texto).replace(/\s+/g, " ").trim();

export function estadoOperacion(operacion) {
  return {
    running: "En curso", ok: "Completado", partial: "Datos parciales", historical: "Recuperado",
    denied: "Denegado", unavailable: "Sin datos", cancelled: "Cancelado",
  }[operacion.estado] ?? "Sin resultado";
}

export function bloqueOperacion(turno, operacion) {
  const total = operacion.resultado?.observaciones?.length;
  const estado = [operacion.label, estadoOperacion(operacion),
    total ? `${total} ${total === 1 ? "observación" : "observaciones"}` : ""].filter(Boolean).join(" · ");
  const previa = operacion.resultado?.resumen || operacion.resultado?.motivos?.[0];
  return {id: `${turno}/herramienta/${operacion.id}`, turno, tipo: "herramienta", operacion,
    text: previa ? estado + "\n" + previa : estado};
}

export function detalleOperacionInspeccion(operacion) {
  const parametros = operacion.parametros && Object.entries(operacion.parametros)
    .map(([clave, valor]) => `${clave} = ${valor}`).join(" · ");
  const duracion = operacion.duracionMs;
  const resultado = operacion.resultado;
  const observaciones = resultado?.observaciones?.map(dato => `${dato.nombre} · ${dato.valor}\n  [${dato.referencia}]`) ?? [];
  const salida = operacion.estado === "running" ? "Salida pendiente." :
    resultado ? "Salida sin observaciones guardadas." : "Consulta Detalle de turnos para ver las observaciones guardadas.";
  return [
    [`Estado · ${estadoOperacion(operacion)}` + (Number.isFinite(duracion) ? ` · ${(duracion / 1000).toFixed(1)} s` : ""),
      operacion.herramienta && `Operación · ${operacion.herramienta}`,
      operacion.alcance && `Alcance · ${operacion.alcance}`,
      operacion.parametros && `Parámetros · ${parametros || "ninguno"}`].filter(Boolean).join("\n"),
    observaciones.length ? "Salida\n" + observaciones.join("\n") : salida,
    resultado?.motivos?.length && "Notas\n" + resultado.motivos.join("\n"),
    operacion.auditoria && "/auditoria " + operacion.auditoria,
  ].filter(Boolean).join("\n\n");
}

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
    for (const operacion of turno.operaciones ?? []) transcript.push(bloqueOperacion(id, operacion));
    transcript.push({ id: id + "/respuesta", tipo: "mensaje",
      text: "Agente  " + (turno.respuesta ?? "Turno sin resultado guardado.") });
    if (turno.auditoria) transcript.push({ id: id + "/detalle", tipo: "detalle", turno: id,
      text: [...(turno.detalle ?? []), "/auditoria " + turno.auditoria].join("\n") });
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
