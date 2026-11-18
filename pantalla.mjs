import {
  CombinedAutocompleteProvider, Container, Editor, matchesKey, ProcessTerminal,
  ScrollView, SelectList, Text, truncateToWidth, TuiAltScreen, visibleWidth, VStack,
} from "@earendil-works/pi-tui";
import { ocultarClaveOpenAI } from "./proveedor-openai.mjs";

const acento = (texto) => `\x1b[96m${texto}\x1b[39m`;
const simple = (texto) => texto;
const tema = {
  selectedPrefix: acento, selectedText: acento, description: simple, scrollInfo: simple, noMatch: simple,
};

function resumenControlWifi(control) {
  const adaptador = control?.adapter;
  const alcance = control?.scope;
  const filtros = [
    [alcance?.allowedBssids.length, "BSSID"],
    [alcance?.allowedSsids.length, "SSID"],
    [alcance?.allowedChannels.length, "canal(es)"],
  ].filter(([cantidad]) => cantidad).map(([cantidad, tipo]) => `${cantidad} ${tipo}`);
  const preflight = control?.preflight;
  const nombre = String(adaptador?.name ?? (adaptador ? "guardado" : "ninguno")).replace(/[\x00-\x1f\x7f-\x9f]/g, "");
  return `Adaptador: ${nombre} | Alcance: ${filtros.join(", ") || "pendiente"} | Preflight: ${preflight ? (preflight.ok ? "OK" : "Bloqueado") : "Pendiente"}`;
}

class EditorConsola extends Editor {
  prefijo = undefined;

  renderTopBorder(width, ocultas) {
    return this.prefijo === undefined ? super.renderTopBorder(width, ocultas) : "";
  }

  renderBottomBorder(width, ocultas) {
    return this.prefijo === undefined ? super.renderBottomBorder(width, ocultas) : "";
  }

  render(width) {
    if (this.prefijo === undefined) return super.render(width);
    const prefijo = truncateToWidth(` ${this.prefijo} `, Math.max(0, width - 4), "");
    const columnas = visibleWidth(prefijo);
    return super.render(width - columnas).filter(Boolean).map((linea, indice) =>
      `${indice === 0 ? acento(prefijo) : " ".repeat(columnas)}${linea}`);
  }
}

export function pantalla(comandos, acciones) {
  const ui = new TuiAltScreen(new ProcessTerminal(), true);
  const encabezado = new Text("", 1);
  const controlWifi = new Text("", 1);
  const historial = new Container();
  const viewport = new ScrollView(historial, { follow: "end", primary: true, scrollbar: "auto" });
  const fila = new Text("", 1);
  const etiqueta = new Text("", 1);
  const panel = new Container();
  const editor = new EditorConsola(ui, { borderColor: acento, selectList: tema }, { paddingX: 1 });
  const completar = new CombinedAutocompleteProvider(
    Object.entries(comandos).map(([name, description]) => ({ name: name.slice(1), description })), process.cwd(),
  );
  editor.setAutocompleteProvider({
    getSuggestions: async (lineas, fila, columna, opciones) => {
      if (pregunta || fila !== 0 || columna !== lineas[fila].length || !/^\/[a-z-]*$/.test(lineas[fila])) {
        return null;
      }
      const sugerencias = await completar.getSuggestions(lineas, fila, columna, { ...opciones, force: false });
      if (!sugerencias) return null;
      const items = sugerencias.items.filter(({ value }) =>
        Object.hasOwn(estado?.comandos ?? {}, `/${value}`) && value.startsWith(sugerencias.prefix.slice(1)))
        .map((item) => ({ ...item, label: `/${item.label}` }));
      return { ...sugerencias, items };
    },
    applyCompletion(lineas, fila, columna, item, prefijo) {
      if (pregunta || fila !== 0 || columna !== lineas[fila].length || lineas[fila] !== prefijo ||
          !Object.hasOwn(estado?.comandos ?? {}, `/${item.value}`)) {
        return { lines: lineas, cursorLine: fila, cursorCol: columna };
      }
      return completar.applyCompletion(lineas, fila, columna, item, prefijo);
    },
  });
  ui.setLayoutRoot(new VStack([
    encabezado, { component: controlWifi, visible: () => Boolean(estado && !estado.agente) },
    { component: viewport, grow: 1, basis: 0 },
    { component: etiqueta, visible: () => Boolean(estado?.agente && !pregunta) },
    { component: editor, visible: () => !selector },
    { component: panel, visible: () => Boolean(selector) },
    { component: fila, visible: () => Boolean(!selector && estado?.agentes.length) },
  ]));
  let selector;
  let esperando;
  let cerrado = false;
  let enFila = false;
  let indice = 0;
  let estado;
  let mensajesVisibles;
  let pregunta;
  let alcance;
  const borradores = new Map();
  function resolverEntrada(texto) {
    const resolver = esperando;
    esperando = undefined;
    pregunta = undefined;
    selector = undefined;
    panel.clear();
    resolver?.(texto);
    render(estado);
  }
  editor.onSubmit = (texto) => {
    if (texto.trim() === "/salir") {
      acciones.salir();
      return;
    }
    if ((!texto && !pregunta) || !esperando) return;
    const visible = ocultarClaveOpenAI(texto);
    if (!pregunta && visible) editor.addToHistory(visible);
    resolverEntrada(visible);
  };
  ui.addInputListener((dato) => {
    if (matchesKey(dato, "ctrl+c") || (matchesKey(dato, "ctrl+d") && !editor.getText())) {
      acciones.salir();
      return { consume: true };
    }
    if (selector) return undefined;
    if (pregunta && matchesKey(dato, "escape")) {
      editor.setText("");
      resolverEntrada(undefined);
      return { consume: true };
    }
    if (matchesKey(dato, "escape") && (enFila || (estado?.agente && !editor.capturesViewportInput))) {
      if (enFila) enFila = false;
      else acciones.volver();
      render(estado);
      return { consume: true };
    }
    if (matchesKey(dato, "tab") && !editor.getText() && !pregunta && estado?.agentes.length) {
      enFila = !enFila;
      render(estado);
      return { consume: true };
    }
    if (!enFila) return undefined;
    if (dato === "/" || matchesKey(dato, "/")) {
      enFila = false;
      render(estado);
      return undefined;
    }
    if (matchesKey(dato, "left")) indice = Math.max(0, indice - 1);
    if (matchesKey(dato, "right")) indice = Math.min(estado.agentes.length - 1, indice + 1);
    if (matchesKey(dato, "enter")) {
      enFila = false;
      acciones.entrar(estado.agentes[indice].id);
    }
    render(estado);
    return { consume: true };
  });

  function render(nuevo) {
    if (cerrado || !nuevo) return;
    const siguiente = pregunta ? "pregunta" : JSON.stringify([nuevo.rutaProyecto, nuevo.agente]);
    if (alcance !== siguiente) {
      if (alcance && alcance !== "pregunta") borradores.set(alcance, ocultarClaveOpenAI(editor.getText()));
      editor.setText(borradores.get(siguiente) ?? "");
      alcance = siguiente;
    }
    estado = nuevo;
    if (!nuevo.agentes.length) enFila = false;
    const contexto = nuevo.proyecto ? `${nuevo.proyecto}  ·  ${nuevo.cliente}` : "Sin proyecto";
    encabezado.setText(`${acento("Harwiff")}  ·  ${contexto}`);
    controlWifi.setText(resumenControlWifi(nuevo.controlWifi));
    editor.prefijo = pregunta || (nuevo.agente ? undefined : nuevo.promptEntorno);
    etiqueta.setText(nuevo.agente ? `agente/${nuevo.agente} >  ·  Esc vuelve a ${nuevo.promptEntorno}` : "");
    indice = Math.min(indice, Math.max(0, nuevo.agentes.length - 1));
    const agentes = nuevo.agentes.map(({ id, estado, actividad }, n) => {
      const reciente = actividad ? ` · ${truncateToWidth(actividad, 28, "…")}` : "";
      const texto = `${id} · ${estado}${reciente}`;
      return enFila && n === indice ? acento(`[${texto}]`) : texto;
    });
    fila.setText(`Agentes  ${agentes.join("   |   ")}${enFila ? "   ← → y Enter" : "   ·   Tab"}`);
    if (mensajesVisibles !== nuevo.mensajes) {
      historial.clear();
      for (const mensaje of nuevo.mensajes) historial.addChild(new Text(mensaje, 1));
      viewport.scrollToEnd();
      mensajesVisibles = nuevo.mensajes;
    }
    ui.setFocus(selector ?? (enFila ? null : editor));
    ui.requestRender();
  }

  ui.start();
  return {
    render,
    leer() {
      return cerrado ? Promise.resolve(undefined) : new Promise((resuelve) => { esperando = resuelve; });
    },
    preguntar(texto) {
      if (cerrado) return Promise.resolve(undefined);
      pregunta = texto;
      render(estado);
      return new Promise((resuelve) => { esperando = resuelve; });
    },
    elegir(titulo, opciones, activa) {
      if (cerrado) return Promise.resolve(undefined);
      return new Promise((resuelve) => {
        esperando = resuelve;
        enFila = false;
        selector = new SelectList(opciones, Math.max(2, Math.min(8, ui.terminal.rows - 8)), tema);
        const indice = opciones.findIndex((opcion) => opcion.value === activa);
        if (indice >= 0) selector.setSelectedIndex(indice);
        selector.onSelect = ({ value }) => resolverEntrada(value);
        selector.onCancel = () => resolverEntrada(undefined);
        panel.addChild(new Text(titulo, 1));
        panel.addChild(selector);
        render(estado);
      });
    },
    cerrar() {
      if (cerrado) return;
      cerrado = true;
      esperando?.(undefined);
      ui.stop();
    },
  };
}
