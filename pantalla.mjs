import {
  CombinedAutocompleteProvider, Container, Editor, matchesKey, ProcessTerminal,
  ScrollView, Text, truncateToWidth, TuiAltScreen, visibleWidth, VStack,
} from "@earendil-works/pi-tui";

const acento = (texto) => `\x1b[96m${texto}\x1b[39m`;
const simple = (texto) => texto;
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
  const historial = new Container();
  const viewport = new ScrollView(historial, { follow: "end", primary: true, scrollbar: "auto" });
  const fila = new Text("", 1);
  const etiqueta = new Text("", 1);
  const editor = new EditorConsola(ui, { borderColor: acento, selectList: tema }, { paddingX: 1 });
  const completar = new CombinedAutocompleteProvider(
    Object.entries(comandos).map(([name, description]) => ({ name: name.slice(1), description })), process.cwd(),
  );
  editor.setAutocompleteProvider({
    getSuggestions: async (lineas, fila, columna, opciones) => {
      if (fila !== 0 || !/^\/[a-z-]*$/.test(lineas[fila].slice(0, columna))) return null;
      return completar.getSuggestions(lineas, fila, columna, { ...opciones, force: false });
    },
    applyCompletion: completar.applyCompletion.bind(completar),
  });
  ui.setLayoutRoot(new VStack([
    encabezado, { component: viewport, grow: 1, basis: 0 },
    { component: etiqueta, visible: () => Boolean(estado?.agente && !pregunta) },
    editor,
    { component: fila, visible: () => Boolean(estado?.agentes.length) },
  ]));
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
    resolver?.(texto);
    render(estado);
  }
  editor.onSubmit = (texto) => {
    if (texto.trim() === "/salir") {
      acciones.salir();
      return;
    }
    if ((!texto && !pregunta) || !esperando) return;
    if (!pregunta && texto) editor.addToHistory(texto);
    resolverEntrada(texto);
  };
  ui.addInputListener((dato) => {
    if (matchesKey(dato, "ctrl+c") || (matchesKey(dato, "ctrl+d") && !editor.getText())) {
      acciones.salir();
      return { consume: true };
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
      if (alcance && alcance !== "pregunta") borradores.set(alcance, editor.getText());
      editor.setText(borradores.get(siguiente) ?? "");
      alcance = siguiente;
    }
    estado = nuevo;
    if (!nuevo.agentes.length) enFila = false;
    const contexto = nuevo.proyecto ? `${nuevo.proyecto}  ·  ${nuevo.cliente}` : "Sin proyecto";
    encabezado.setText(`${acento("Harwiff")}  ·  ${contexto}`);
    editor.prefijo = pregunta || (nuevo.agente ? undefined : "wifi >");
    etiqueta.setText(nuevo.agente ? `agente/${nuevo.agente} >  ·  Esc vuelve a wifi` : "");
    indice = Math.min(indice, Math.max(0, nuevo.agentes.length - 1));
    const agentes = nuevo.agentes.map(({ id, estado }, n) => {
      const texto = `${id} · ${estado}`;
      return enFila && n === indice ? acento(`[${texto}]`) : texto;
    });
    fila.setText(`Agentes  ${agentes.join("   |   ")}${enFila ? "   ← → y Enter" : "   ·   Tab"}`);
    if (mensajesVisibles !== nuevo.mensajes) {
      historial.clear();
      for (const mensaje of nuevo.mensajes) historial.addChild(new Text(mensaje, 1));
      viewport.scrollToEnd();
      mensajesVisibles = nuevo.mensajes;
    }
    ui.setFocus(enFila ? null : editor);
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
    cerrar() {
      if (cerrado) return;
      cerrado = true;
      esperando?.(undefined);
      ui.stop();
    },
  };
}
