import { entorno } from "./entorno.mjs";

const CRITICIDAD = {
  critical: "Conexión principal",
  potentially_critical: "Radio potencialmente crítico",
  noncritical: "Sin ruta crítica detectada",
  unknown: "Conectividad desconocida",
};
const DECLARACION = { supported: "anunciado", unsupported: "no anunciado", unknown: "desconocido" };
const RESERVA = { leased: "reserva de Harwiff observada", free: "sin reserva local observada", unknown: "reserva local desconocida" };
const dato = (valor) => valor ?? "desconocido";
const bloqueo = (valor) => valor === null ? "desconocido" : valor ? "sí" : "no";
const nombres = (phy) => phy.interfaces.map(({ ifname }) => ifname).join(", ") || "sin interfaces";
const conexion = (phy) => phy.interfaces.length && phy.interfaces.every(({ connected }) => connected === false)
  ? " · desconectado" : "";
const mock = "Mock · Simulado\nEscenario sintético local. La selección requiere alcance y preflight.";
const avisos = (lista) => lista.map(({ code, source, message }) => `${source} · ${code} · ${message}`);
const radios = (perfil) => perfil.devices.flatMap((dispositivo) =>
  dispositivo.phys.map((phy) => ({ dispositivo, phy })));

function resumen({ dispositivo, phy }) {
  const { monitor, concurrency } = phy.capabilities;
  return [
    `${phy.nameNow} · ${nombres(phy)} · ${dispositivo.bus.toUpperCase()}`,
    `${CRITICIDAD[phy.connectivity.criticality]} · ${RESERVA[phy.reservation.state]}${conexion(phy)}`,
    `Monitor ${DECLARACION[monitor.declared]} · Concurrencia ${DECLARACION[concurrency.declared]} · Sin pruebas operativas`,
  ].join("\n");
}

function restricciones({ phy }, perfil) {
  return [
    CRITICIDAD[phy.connectivity.criticality],
    ...phy.connectivity.reasons.map((razon) => ({
      default_route_interface: "Una interfaz del radio sostiene una ruta por defecto.",
      default_routes_indeterminate: "Las rutas IPv4 o IPv6 no se pudieron verificar.",
      unresolved_default_route_dependency: "No se conoce la dependencia de una ruta por defecto.",
    })[razon]),
    RESERVA[phy.reservation.state],
    `Bloqueo rfkill lógico ${bloqueo(phy.rfkill.softBlocked)} · físico ${bloqueo(phy.rfkill.hardBlocked)}`,
    "Coordinación limitada a Harwiff. La selección requiere preflight.",
    ...avisos([...perfil.warnings, ...phy.probe.warnings]),
  ].join("\n");
}

function capacidades({ dispositivo, phy }) {
  const cap = phy.capabilities;
  const combinaciones = cap.interfaceCombinations.items?.map(({ maxInterfaces, maxDifferentChannels, limits, requiresMatchingBeaconIntervals }) =>
    `${maxInterfaces} interfaces · ${maxDifferentChannels} canales · ${limits.map(({ modes, max }) => `${modes.join("/")} ≤ ${max}`).join(", ")}${requiresMatchingBeaconIntervals ? " · intervalos beacon iguales" : ""}`);
  return [
    `Driver ${dato(dispositivo.driver)} · Firmware ${dato(dispositivo.firmware)}`,
    ...phy.interfaces.map(({ ifname, type, linkState, nmState, connected }) =>
      `${ifname} · ${dato(type)} · enlace ${linkState} · NetworkManager ${nmState} · ${connected === null ? "asociación desconocida" : connected ? "conectado" : "desconectado"}`),
    `Modos anunciados · ${dato(cap.interfaceModes?.join(", "))}`,
    `Modos de software · ${dato(cap.softwareInterfaceModes?.join(", "))}`,
    `Bandas · ${dato(cap.bands?.join(", "))} · Regulación ${dato(phy.regulatory.country)}`,
    `Monitor ${DECLARACION[cap.monitor.declared]} · Inyección ${DECLARACION[cap.injection.declared]} · Sin pruebas operativas`,
    "Combinaciones anunciadas",
    ...(combinaciones ?? ["Desconocidas"]),
    "Frecuencias anunciadas",
    ...(cap.channels?.map(({ frequencyMHz, channel, flags }) =>
      `${frequencyMHz} MHz · canal ${channel}${flags.length ? ` · ${flags.join(", ")}` : ""}`) ?? ["Desconocidas"]),
  ].join("\n");
}

export async function detalleAdaptador(nombre) {
  if (nombre === "mock") return mock;
  const perfil = await entorno("adaptadores-perfil");
  const filas = radios(perfil).filter(({ phy }) => phy.nameNow === nombre || phy.interfaces.some((i) => i.ifname === nombre));
  if (filas.length !== 1) throw new Error("El adaptador no aparece en el inventario o su nombre es ambiguo.");
  const fila = filas[0];
  return [resumen(fila), capacidades(fila), restricciones(fila, perfil)].join("\n\n");
}

export async function panelAdaptadores(interfaz, seleccionado, usar) {
  let perfil;
  for (;;) {
    perfil ??= await interfaz.consultar("Cargando inventario de adaptadores…",
      (signal) => entorno("adaptadores-perfil", undefined, { signal }));
    if (!perfil) return;
    const filas = radios(perfil);
    const opciones = filas.map((fila, indice) => {
      const { dispositivo, phy } = fila;
      return { value: String(indice), label: `${phy.nameNow} · ${nombres(phy)}`,
        description: `${dispositivo.bus} · ${CRITICIDAD[phy.connectivity.criticality]} · ${RESERVA[phy.reservation.state]}${conexion(phy)}` };
    });
    const parcial = perfil.status === "complete" ? "" : " · inventario parcial";
    const opcion = await interfaz.elegir(`Harwiff / Adaptadores${parcial}\nSeleccionado en el proyecto: ${seleccionado ?? "ninguno"}`, [
      ...opciones, { value: "mock", label: "Mock · Simulado" }, { value: "actualizar", label: "Actualizar inventario" },
      { value: "volver", label: "Volver" },
    ]);
    if (!opcion || opcion === "volver") return;
    if (opcion === "actualizar") {
      perfil = undefined;
      continue;
    }
    const fila = filas[Number(opcion)];
    const accion = await interfaz.elegir(fila ? resumen(fila) : mock, [
      { value: "usar", label: "Usar este adaptador" },
      ...(fila ? [{ value: "capacidades", label: "Ver capacidades completas" },
        { value: "restricciones", label: "Ver restricciones y motivos" }] :
        [{ value: "avisos", label: "Ver avisos del inventario" }]),
      { value: "volver", label: "Volver" },
    ]);
    if (accion === "usar") {
      if (!fila) return usar("mock");
      const { phy } = fila;
      const candidatos = phy.interfaces.filter(({ legacyAdapterId, ifindex }) => legacyAdapterId && ifindex);
      if (!candidatos.length) {
        await interfaz.mostrarDetalle("El radio no tiene una interfaz operativa identificable.", "Esc vuelve al inventario");
        continue;
      }
      let nombre = candidatos[0].ifname;
      if (candidatos.length > 1) {
        nombre = await interfaz.elegir("Interfaz para verificar con preflight",
          candidatos.map(({ ifname }) => ({ value: ifname, label: ifname })));
        if (!nombre) continue;
      }
      const { legacyAdapterId, interfaceId, ifindex } = candidatos.find(({ ifname }) => ifname === nombre);
      return usar(nombre, legacyAdapterId, { phyId: phy.phyId, interfaceId, ifindex, ifname: nombre });
    }
    if (accion === "capacidades" || accion === "restricciones" || accion === "avisos") {
      const texto = accion === "capacidades" ? capacidades(fila) : accion === "restricciones" ? restricciones(fila, perfil) :
        avisos(perfil.warnings).join("\n") || "Sin advertencias generales.";
      await interfaz.mostrarDetalle(texto, "Esc vuelve al inventario");
    }
  }
}
