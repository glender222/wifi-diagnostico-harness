import {
  CombinedAutocompleteProvider, Container, decodeKittyPrintable, Editor, isKeyRelease, matchesKey, Markdown, ProcessTerminal,
  ScrollView, SelectList, Text, truncateToWidth, TuiAltScreen, visibleWidth, VStack,
} from "@earendil-works/pi-tui";

import { resumenControlWifi } from "./proyecto.mjs";

const acento = (texto) => `\x1b[96m${texto}\x1b[39m`;
const simple = (texto) => texto;
const fuerte = (texto) => `\x1b[1m${texto}\x1b[22m`;
const temaMarkdown = {
  heading: fuerte, link: acento, linkUrl: simple, code: acento, codeBlock: simple, codeBlockBorder: simple,
  quote: simple, quoteBorder: acento, hr: simple, listBullet: acento, bold: fuerte,
  italic: (texto) => `\x1b[3m${texto}\x1b[23m`, strikethrough: simple, underline: simple,
};
const tema = {
  selectedPrefix: acento, selectedText: acento, description: simple, scrollInfo: simple, noMatch: simple,
};

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
  const campoSecreto = new Text("", 1);
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
    { component: editor, visible: () => !selector && !secreto && !detalle },
    { component: campoSecreto, visible: () => Boolean(secreto) },
    { component: panel, visible: () => Boolean(selector || detalle) },
    { component: fila, visible: () => Boolean(!selector && !detalle && estado?.agentes.length) },
  ]));
  let selector;
  let detalle;
  let filtroSelector;
  const filtroVisible = new Text("", 1);
  let esperando;
  let cerrado = false;
  let enFila = false;
  let indice = 0;
  let estado;
  let bloquesVisibles = new Map();
  let vistaHistorial;
  let pregunta;
  let secreto;
  let alcance;
  const borradores = new Map();
  function resolverEntrada(texto) {
    const resolver = esperando;
    esperando = undefined;
    pregunta = undefined;
    secreto = undefined;
    selector = undefined;
    detalle = undefined;
    filtroSelector = undefined;
    panel.clear();
    resolver?.(texto);
    render(estado);
  }
  editor.onSubmit = (texto) => {
    if (pregunta && !estado?.agente && texto.trim() === "/salir") {
      acciones.salir();
      return;
    }
    if (!texto && !pregunta) return;
    const visible = acciones.ocultar(texto);
    if (!pregunta && estado?.autonoma && visible.trim() && !visible.trimStart().startsWith("/")) {
      editor.addToHistory(visible);
      acciones.enviar(estado.agente, visible.trim());
      return;
    }
    if (!esperando) return;
    if (!pregunta && visible) editor.addToHistory(visible);
    resolverEntrada(visible);
  };
  function capturarSecreto(dato) {
    if (isKeyRelease(dato)) return;
    if (matchesKey(dato, "escape")) {
      resolverEntrada(undefined);
      return;
    }
    if (matchesKey(dato, "enter")) {
      resolverEntrada(secreto.valor);
      return;
    }
    if (matchesKey(dato, "backspace")) secreto.valor = secreto.valor.slice(0, -1);
    else if (matchesKey(dato, "ctrl+u")) secreto.valor = "";
    else {
      const entrada = dato.startsWith("\x1b[200~") && dato.endsWith("\x1b[201~")
        ? dato.slice(6, -6).trim() : decodeKittyPrintable(dato) ?? dato;
      if (/^[a-zA-Z0-9_-]+$/.test(entrada) && secreto.valor.length + entrada.length <= 512) secreto.valor += entrada;
    }
    render(estado);
  }
  ui.addInputListener((dato) => {
    if (matchesKey(dato, "ctrl+c") || (matchesKey(dato, "ctrl+d") && !secreto && !editor.getText())) {
      acciones.salir();
      return { consume: true };
    }
    if (secreto) {
      capturarSecreto(dato);
      return { consume: true };
    }
    if (detalle) {
      if (!isKeyRelease(dato) && (matchesKey(dato, "escape") || matchesKey(dato, "enter"))) {
        resolverEntrada(undefined);
        return { consume: true };
      }
      return undefined;
    }
    if (selector) {
      if (filtroSelector !== undefined && !isKeyRelease(dato)) {
        const caracter = decodeKittyPrintable(dato) ?? dato;
        if (matchesKey(dato, "backspace")) filtroSelector = filtroSelector.slice(0, -1);
        else if (matchesKey(dato, "ctrl+u")) filtroSelector = "";
        else if (/^[\w./:-]$/.test(caracter)) filtroSelector += caracter;
        else return undefined;
        selector.setFilter(filtroSelector);
        filtroVisible.setText(`Filtrar por ID · ${filtroSelector}`);
        ui.requestRender();
        return { consume: true };
      }
      return undefined;
    }
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
      if (alcance && alcance !== "pregunta") borradores.set(alcance, acciones.ocultar(editor.getText()));
      editor.setText(borradores.get(siguiente) ?? "");
      alcance = siguiente;
    }
    estado = nuevo;
    if (!nuevo.agentes.length) enFila = false;
    const contexto = nuevo.proyecto ? `${nuevo.proyecto}  ·  ${nuevo.cliente}` : "Sin proyecto";
    const llm = !nuevo.agente && nuevo.proveedor ? `  ·  ${nuevo.proveedor}${nuevo.modelo ? ` / ${nuevo.modelo}` : ""}` : "";
    encabezado.setText(`${acento("Harwiff")}  ·  ${contexto}${llm}`);
    controlWifi.setText(resumenControlWifi(nuevo.controlWifi));
    editor.prefijo = pregunta || (nuevo.agente ? undefined : nuevo.promptEntorno);
    etiqueta.setText(nuevo.agente ? `agente/${nuevo.agente} >  ·  Esc vuelve a ${nuevo.promptEntorno}${nuevo.soloConsulta ? "  ·  Solo consulta" : ""}` : "");
    if (secreto) campoSecreto.setText(`${secreto.titulo} ${"•".repeat(Math.min(32, secreto.valor.length))}`);
    indice = Math.min(indice, Math.max(0, nuevo.agentes.length - 1));
    const agentes = nuevo.agentes.map(({ id, estado, actividad }, n) => {
      const reciente = actividad ? ` · ${truncateToWidth(actividad, 28, "…")}` : "";
      const texto = `${id} · ${estado}${reciente}`;
      return enFila && n === indice ? acento(`[${texto}]`) : texto;
    });
    fila.setText(`Agentes  ${agentes.join("   |   ")}${enFila ? "   ← → y Enter" : "   ·   Tab"}`);
    const vista = JSON.stringify([nuevo.rutaProyecto, nuevo.agente, Boolean(detalle)]);
    if (vistaHistorial !== vista) {
      historial.clear();
      bloquesVisibles.clear();
      if (detalle) viewport.scrollToStart();
      else viewport.scrollToEnd();
      vistaHistorial = vista;
    }
    const proximos = new Map();
    const bloques = detalle ? [{ id: "detalle", text: detalle }] :
      [...(nuevo.transcript ?? []), ...nuevo.mensajes.map((text, indice) => ({ id: `aviso/${indice}`, text }))];
    for (const bloque of bloques) {
      const anterior = bloquesVisibles.get(bloque.id);
      const componente = anterior?.componente ??
        (bloque.markdown ? new Markdown(bloque.text, 1, 0, temaMarkdown) : new Text(bloque.text, 1));
      if (anterior && anterior.text !== bloque.text) componente.setText(bloque.text);
      proximos.set(bloque.id, { componente, text: bloque.text });
    }
    const componentes = [...proximos.values()].map(({ componente }) => componente);
    if (historial.children.length !== componentes.length || componentes.some((item, i) => historial.children[i] !== item)) {
      historial.clear();
      for (const componente of componentes) historial.addChild(componente);
    }
    bloquesVisibles = proximos;
    ui.setFocus(selector ?? (enFila || secreto || detalle ? null : editor));
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
    preguntarSecreto(titulo) {
      if (cerrado) return Promise.resolve(undefined);
      return new Promise((resuelve) => {
        esperando = resuelve;
        enFila = false;
        secreto = { titulo, valor: "" };
        render(estado);
      });
    },
    elegir(titulo, opciones, activa, { filtrar = false } = {}) {
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
        if (filtrar) {
          filtroSelector = "";
          filtroVisible.setText("Filtrar por ID");
          panel.addChild(filtroVisible);
        }
        panel.addChild(selector);
        render(estado);
      });
    },
    mostrarDetalle(texto) {
      if (cerrado) return Promise.resolve();
      return new Promise((resuelve) => {
        esperando = resuelve;
        detalle = texto;
        panel.addChild(new Text("Detalles de operación · Esc vuelve a la sesión", 1));
        render(estado);
      });
    },
    cerrar() {
      if (cerrado) return;
      cerrado = true;
      secreto = undefined;
      esperando?.(undefined);
      ui.stop();
    },
  };
}
