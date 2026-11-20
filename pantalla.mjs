import {
  CombinedAutocompleteProvider, Container, decodeKittyPrintable, Editor, isKeyRelease, matchesKey, Markdown, ProcessTerminal,
  HStack, ScrollView, SelectList, Text, truncateToWidth, TuiAltScreen, visibleWidth, VStack,
} from "@earendil-works/pi-tui";

import { resumenControlWifi } from "./proyecto.mjs";

const simple = (texto) => texto;
const sinColor = Object.hasOwn(process.env, "NO_COLOR");
const acento = sinColor ? simple : (texto) => `\x1b[96m${texto}\x1b[39m`;
const fuerte = (texto) => `\x1b[1m${texto}\x1b[22m`;
const temaMarkdown = {
  heading: fuerte, link: acento, linkUrl: simple, code: acento, codeBlock: simple, codeBlockBorder: simple,
  quote: simple, quoteBorder: acento, hr: simple, listBullet: acento, bold: fuerte,
  italic: (texto) => `\x1b[3m${texto}\x1b[23m`, strikethrough: simple, underline: simple,
};
const tema = {
  selectedPrefix: acento, selectedText: acento, description: simple, scrollInfo: simple, noMatch: simple,
};
const temaMenu = {
  ...tema,
  selectedText: (texto) => acento(texto.replace(/^→ /, "> ")),
  noMatch: () => "Sin coincidencias",
};
const dimensionesValidas = ({ width, height }) => width >= 60 && height >= 16;

// Recalcula la ventana visible cuando cambia el tamaño. La selección usa el ID del elemento.
class ListaMenu {
  capturesViewportInput = true;

  constructor(opciones, filas, callbacks) {
    this.opciones = opciones;
    this.filas = filas;
    this.callbacks = callbacks;
    this.filtro = "";
    this.seleccion = callbacks.activa;
    this.actualizarLista();
  }

  setItems(opciones) {
    if (opciones.length === this.opciones.length && opciones.every((item, i) => {
      const anterior = this.opciones[i];
      return anterior.value === item.value && anterior.label === item.label && anterior.description === item.description;
    })) return;
    this.opciones = opciones;
    this.actualizarLista(true);
  }

  actualizarLista(forzar = false) {
    const filas = this.filas();
    if (!forzar && this.lista && filas === this.maxVisible) return;
    this.maxVisible = filas;
    const lista = new SelectList(this.opciones, filas, temaMenu, {
      minPrimaryColumnWidth: 20, maxPrimaryColumnWidth: 30,
      truncatePrimary: ({ text, maxWidth }) => truncateToWidth(text, maxWidth, "..."),
    });
    lista.setFilter(this.filtro);
    const indice = this.opciones.filter(({ value }) => value.toLowerCase().startsWith(this.filtro.toLowerCase()))
      .findIndex(({ value }) => value === this.seleccion);
    lista.setSelectedIndex(indice);
    lista.onSelectionChange = ({ value }) => {
      this.seleccion = value;
      this.callbacks.cambiar?.(value);
    };
    lista.onSelect = this.callbacks.elegir;
    lista.onCancel = this.callbacks.cancelar;
    this.lista = lista;
  }

  setFilter(filtro) {
    this.filtro = filtro;
    this.lista.setFilter(filtro);
    this.seleccion = this.lista.getSelectedItem()?.value;
  }

  render(width) {
    this.actualizarLista();
    return this.lista.render(width);
  }

  handleInput(dato) {
    this.lista.handleInput(dato);
  }

  invalidate() {
    this.lista.invalidate();
  }
}

function zonaTexto(opciones) {
  const contenido = new Container();
  const estilos = sinColor ? { scrollbarTrackStyle: simple, scrollbarThumbStyle: simple } : {};
  return { contenido, bloques: new Map(), vista: new ScrollView(contenido, { ...opciones, ...estilos }) };
}

function actualizarBloques(zona, bloques, limpiar) {
  const proximos = new Map();
  for (const bloque of bloques) {
    const texto = limpiar(bloque.text);
    const anterior = zona.bloques.get(bloque.id);
    const componente = anterior?.componente ?? (bloque.markdown
      ? new Markdown(texto, 1, 0, temaMarkdown) : new Text(texto, 1));
    if (anterior && anterior.texto !== texto) componente.setText(texto);
    proximos.set(bloque.id, { componente, texto });
  }
  const componentes = [...proximos.values()].map(({ componente }) => componente);
  const hijos = zona.contenido.children;
  if (hijos.length !== componentes.length || componentes.some((item, i) => hijos[i] !== item)) {
    zona.contenido.clear();
    for (const componente of componentes) zona.contenido.addChild(componente);
  }
  zona.bloques = proximos;
}

class Linea {
  texto = "";

  setText(texto) {
    this.texto = texto;
  }

  render(width) {
    return this.texto ? [truncateToWidth(" " + this.texto, width, "...")] : [];
  }

  invalidate() {}
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
  const encabezado = new Linea();
  const controlWifi = new Text("", 1);
  const estadoVisible = new Linea();
  const principal = new Container();
  const conversacion = new HStack([], { gap: 3 });
  const actividad = new Text("", 0, 0);
  const registro = zonaTexto({ follow: "end", primary: true, scrollbar: "auto" });
  const inspector = zonaTexto({ primary: true, scrollbar: "auto" });
  const fila = new Text("", 1);
  const etiqueta = new Text("", 1);
  const tituloCampo = new Text("", 1, 0);
  const panel = new Container();
  const campoSecreto = new Text("", 1, 0);
  const aviso = new Text("", 1, 0);
  const pie = { render: (width) => [truncateToWidth(" " + ayudaTeclado(width), width, "")], invalidate() {} };
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
  const visible = (condicion = () => true) => (terminal) =>
    (compatibilidad || dimensionesValidas(terminal)) && condicion(terminal);
  const menuRaizVisible = () => !compatibilidad && !estado?.agente && !selector && !detalle && !pregunta && !secreto;
  ui.setLayoutRoot(new VStack([
    { component: new Text("Terminal pequeña. Se requieren 60×16.", 0),
      visible: (terminal) => !compatibilidad && !dimensionesValidas(terminal) },
    { component: encabezado, visible: visible() },
    { component: controlWifi, visible: visible(() => compatibilidad && !estado?.agente) },
    { component: estadoVisible, visible: visible(() => !compatibilidad && !detalle && !selector && !pregunta && !secreto) },
    { component: principal, visible: visible(menuRaizVisible) },
    { component: registro.vista, grow: 1, basis: 0, visible: visible(() => compatibilidad && !estado?.agente && !detalle) },
    { component: conversacion, grow: 1, basis: 0,
      visible: visible(() => Boolean(estado?.agente && !detalle && (compatibilidad || (!selector && !pregunta && !secreto)))) },
    { component: panel, visible: visible(() => Boolean(selector || detalle)) },
    { component: inspector.vista, grow: 1, basis: 0, visible: visible(() => Boolean(detalle)) },
    { component: new Text("", 0), grow: 1, basis: 0,
      visible: visible(() => !compatibilidad && (!estado?.agente || selector || pregunta || secreto) && !detalle) },
    { component: etiqueta, visible: visible(() => Boolean(compatibilidad && estado?.agente && !pregunta)) },
    { component: tituloCampo, visible: visible(() => Boolean(!compatibilidad && pregunta)) },
    { component: editor, visible: visible(() => !selector && !secreto && !detalle &&
      Boolean(compatibilidad || pregunta || (estado?.agente && !estado.soloConsulta))) },
    { component: campoSecreto, visible: visible(() => Boolean(secreto)) },
    { component: fila, visible: visible(() => Boolean(compatibilidad && !selector && !detalle && !pregunta &&
      estado?.proyecto && (!estado.agente || estado.agentes.length))) },
    { component: aviso, maxSize: 2, visible: visible(() => Boolean(!compatibilidad && avisoTexto && !detalle && !secreto)) },
    { component: pie, visible: visible(() => !compatibilidad) },
  ]));
  let selector;
  let detalle;
  let consulta;
  let filtroSelector;
  let refrescarSelector;
  const filtroVisible = new Text("", 1);
  let esperando;
  let cerrado = false;
  let enFila = false;
  let indice = 0;
  let estado;
  let compatibilidad = false;
  let avisoTexto = "";
  let listaRaiz;
  let opcionesRaiz;
  let claveRaiz;
  let claveChat;
  let pregunta;
  let alCancelarPregunta;
  let secreto;
  let alcance;
  const borradores = new Map();
  const chats = new Map();
  const selecciones = new Map();

  function ayudaTeclado(ancho) {
    if (consulta) return consulta.cancelable ? "Esc cancelar" : "Espera a que termine la operación";
    if (detalle) return ancho < 80 ? "Flechas leer   Esc volver" : "↑↓ leer   Esc volver";
    if (selector || menuRaizVisible()) {
      const mover = ancho < 80 ? "Flechas mover" : "↑↓ mover";
      return `${mover}   Enter abrir   ${selector ? "Esc volver" : "? ayuda"}`;
    }
    if (pregunta || secreto) return "Enter aceptar   Esc volver";
    const seguir = claveChat && !chats.get(claveChat).vista.isFollowingEnd ? "Ctrl+Fin seguir   " : "";
    return (estado?.soloConsulta ? "" : "Enter enviar   ") + seguir + "Tab acciones   Esc volver";
  }
  function resolverEntrada(texto) {
    const resolver = esperando;
    esperando = undefined;
    if (pregunta && texto === undefined) alCancelarPregunta?.(acciones.ocultar(editor.getText()));
    pregunta = undefined;
    alCancelarPregunta = undefined;
    secreto = undefined;
    selector = undefined;
    detalle = undefined;
    filtroSelector = undefined;
    refrescarSelector = undefined;
    panel.clear();
    resolver?.(texto);
    render(estado);
  }
  editor.onSubmit = (texto) => {
    if (compatibilidad && pregunta && !estado?.agente && texto.trim() === "/salir") {
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
    if (isKeyRelease(dato)) return { consume: true };
    if (!compatibilidad && !dimensionesValidas({ width: ui.terminal.columns, height: ui.terminal.rows }) &&
        !matchesKey(dato, "ctrl+c")) {
      return { consume: true };
    }
    if (matchesKey(dato, "ctrl+c") || (matchesKey(dato, "ctrl+d") && !secreto && !editor.getText())) {
      if (compatibilidad) acciones.salir();
      else if (consulta) consulta.controlador?.abort();
      else if (selector || detalle || pregunta || secreto) resolverEntrada(undefined);
      else if (esperando) resolverEntrada({ accion: "salir" });
      return { consume: true };
    }
    if (secreto) {
      capturarSecreto(dato);
      return { consume: true };
    }
    if (consulta) {
      if (matchesKey(dato, "escape")) consulta.controlador?.abort();
      return { consume: true };
    }
    if (detalle) {
      if (matchesKey(dato, "escape") || matchesKey(dato, "enter")) {
        resolverEntrada(undefined);
        return { consume: true };
      }
      if (matchesKey(dato, "up") || matchesKey(dato, "down")) {
        inspector.vista.scrollBy(matchesKey(dato, "up") ? -1 : 1);
        ui.requestRender();
        return { consume: true };
      }
      return undefined;
    }
    if (selector) {
      if (filtroSelector !== undefined) {
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
      resolverEntrada(undefined);
      return { consume: true };
    }
    if (!compatibilidad && !pregunta) {
      if (menuRaizVisible() && (dato === "/" || matchesKey(dato, "/"))) {
        compatibilidad = true;
        render(estado);
        return undefined;
      }
      if (esperando && menuRaizVisible() && (dato === "?" || matchesKey(dato, "?"))) {
        resolverEntrada({ accion: "ayuda" });
        return { consume: true };
      }
      if (esperando && estado?.agente && matchesKey(dato, "tab") && !editor.capturesViewportInput) {
        resolverEntrada({ accion: "accionesAgente" });
        return { consume: true };
      }
      if (esperando && estado?.agente && matchesKey(dato, "escape") && !editor.capturesViewportInput) {
        resolverEntrada({ accion: "regresarAgentes" });
        return { consume: true };
      }
    }
    if (compatibilidad && !estado?.agente && !pregunta && !enFila && !editor.getText() && matchesKey(dato, "escape")) {
      compatibilidad = false;
      render(estado);
      return { consume: true };
    }
    if (compatibilidad && matchesKey(dato, "escape") && (enFila || (estado?.agente && !editor.capturesViewportInput))) {
      if (enFila) enFila = false;
      else acciones.volver();
      render(estado);
      return { consume: true };
    }
    if (compatibilidad && matchesKey(dato, "tab") && !editor.getText() && !pregunta && estado?.proyecto) {
      if (!estado.agente && esperando) {
        resolverEntrada({ accion: "agentes" });
        return { consume: true };
      }
      if (estado.agentes.length) {
        enFila = !enFila;
        render(estado);
        return { consume: true };
      }
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
    refrescarSelector?.();
    if (!nuevo.agentes.length) enFila = false;
    const contexto = nuevo.proyecto ? [nuevo.proyecto, nuevo.cliente].filter(Boolean).join("  ·  ") : "Sin proyecto";
    const llm = !nuevo.agente && nuevo.proveedor ? `  ·  ${nuevo.proveedor}${nuevo.modelo ? ` / ${nuevo.modelo}` : ""}` : "";
    encabezado.setText(compatibilidad ? `${acento("Harwiff")}  ·  ${contexto}${llm}` :
      `${fuerte("Harwiff")} / ${nuevo.proyecto ?? "Sin proyecto"}${nuevo.agente ? " / Agente" : ""}`);
    controlWifi.setText(resumenControlWifi(nuevo.controlWifi));
    estadoVisible.setText(nuevo.estadoResumen ?? "");
    tituloCampo.setText(pregunta ?? "");
    aviso.setText(avisoTexto);
    editor.prefijo = compatibilidad ? pregunta || (nuevo.agente ? undefined : nuevo.promptEntorno) : pregunta ? ">" : "Mensaje >";
    etiqueta.setText(nuevo.agente ? `agente/${nuevo.agente} >  ·  Esc vuelve a ${nuevo.promptEntorno}${nuevo.soloConsulta ? "  ·  Solo consulta" : ""}` : "");
    if (secreto) campoSecreto.setText(`${secreto.titulo} ${(ui.terminal.columns < 80 ? "*" : "•").repeat(Math.min(32, secreto.valor.length))}`);
    indice = Math.min(indice, Math.max(0, nuevo.agentes.length - 1));
    if (compatibilidad) {
      const agentes = nuevo.agentes.map(({ id, estado, actividad }, n) => {
        const reciente = actividad ? ` · ${truncateToWidth(actividad, 28, "…")}` : "";
        const texto = `${id} · ${estado}${reciente}`;
        return enFila && n === indice ? acento(`[${texto}]`) : texto;
      });
      fila.setText(nuevo.agente
        ? `Agentes  ${agentes.join("   |   ")}${enFila ? "   ← → y Enter" : "   ·   Tab"}`
        : ["Tab Agentes", ...agentes].join("   ·   "));
    }
    if (detalle) {
      actualizarBloques(inspector, [{ id: "detalle", text: detalle }], acciones.limpiar);
    }
    const mensajes = nuevo.mensajes.map((text, n) => ({ id: `aviso/${n}`, text }));
    if (nuevo.agente) {
      const clave = JSON.stringify([nuevo.rutaProyecto, nuevo.agente]);
      if (!chats.has(clave)) chats.set(clave, zonaTexto({ follow: "end", primary: true, scrollbar: "auto" }));
      const zona = chats.get(clave);
      if (claveChat !== clave) {
        claveChat = clave;
        conversacion.clear();
        conversacion.addChild(zona.vista, { grow: 1, basis: 0 });
        conversacion.addChild(actividad, { basis: 34, visible: ({ width }) => !compatibilidad && width >= 120 });
      }
      const bloques = compatibilidad ? nuevo.transcript ?? [] : (nuevo.transcript ?? [])
        .filter(({ tipo }) => tipo === "mensaje")
        .map((bloque) => {
          let texto = bloque.text;
          if (bloque.entrega === "queued") texto = texto.replace(/ · en cola$/, " · En cola");
          if (bloque.entrega === "not_sent") texto = texto.replace(/ · no enviado$/, " · No enviado");
          if (bloque.entrega === "incorporated") texto += " · Incorporado";
          if (bloque.markdown) texto = texto.replace(/^\*\*Harwiff\*\*/, "**Agente**");
          return { ...bloque, text: texto };
        });
      actualizarBloques(zona, [...bloques, ...mensajes], acciones.limpiar);
      actividad.setText(nuevo.actividad.length ? `Actividad\n${nuevo.actividad.slice(-5).map(({ label, description }) =>
        `${label} · ${description}`).join("\n")}` : "Actividad\nSin operaciones");
    } else if (compatibilidad) {
      actualizarBloques(registro, mensajes, acciones.limpiar);
    }
    if (menuRaizVisible()) {
      const firma = JSON.stringify(nuevo.menu);
      const clave = nuevo.rutaProyecto ?? "sin-proyecto";
      if (firma !== opcionesRaiz || clave !== claveRaiz) {
        claveRaiz = clave;
        opcionesRaiz = firma;
        listaRaiz = new ListaMenu(nuevo.menu, () => Math.max(2, ui.terminal.rows - 7), {
          activa: selecciones.get(clave),
          elegir: ({ value }) => {
            if (esperando) resolverEntrada({ accion: value });
          },
          cambiar: (value) => selecciones.set(clave, value),
        });
        principal.clear();
        principal.addChild(listaRaiz);
      }
    }
    const ocupaEditor = !enFila && !secreto && !detalle && (compatibilidad || pregunta || (nuevo.agente && !nuevo.soloConsulta));
    ui.setFocus(selector ?? (menuRaizVisible() ? listaRaiz : ocupaEditor ? editor : null));
    ui.requestRender();
  }

  ui.start();
  const interfaz = {
    render,
    enComandos: () => compatibilidad,
    comandos() {
      compatibilidad = true;
      render(estado);
    },
    notificar(texto) {
      avisoTexto = acciones.limpiar(texto);
      render(estado);
    },
    leer() {
      return cerrado ? Promise.resolve(undefined) : new Promise((resuelve) => { esperando = resuelve; });
    },
    preguntar(texto, inicial = "", { alCancelar } = {}) {
      if (cerrado) return Promise.resolve(undefined);
      pregunta = acciones.limpiar(texto);
      alCancelarPregunta = alCancelar;
      render(estado);
      editor.setText(acciones.limpiar(inicial));
      ui.requestRender();
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
    elegir(titulo, opciones, activa, { filtrar = false, id } = {}) {
      if (cerrado) return Promise.resolve(undefined);
      return new Promise((resuelve) => {
        esperando = resuelve;
        enFila = false;
        const opcionesDinamicas = typeof opciones === "function";
        const filasVisibles = () => (opcionesDinamicas ? opciones() : opciones).map(({ value, label, description }) => ({
          value, label: acciones.limpiar(label), description: description && acciones.limpiar(description),
        }));
        const visibles = filasVisibles();
        const clave = !compatibilidad && id && JSON.stringify([estado.rutaProyecto, estado.agente, id]);
        const seleccion = clave && selecciones.get(clave) || activa;
        const elegir = ({ value }) => {
          if (clave) selecciones.set(clave, value);
          resolverEntrada(value);
        };
        const cancelar = () => resolverEntrada(undefined);
        const cabecera = new Text(acciones.limpiar(titulo), 1, compatibilidad ? 1 : 0);
        if (compatibilidad) {
          selector = new SelectList(visibles, Math.max(2, Math.min(8, ui.terminal.rows - 8)), tema);
          const indice = visibles.findIndex(({ value }) => value === seleccion);
          if (indice >= 0) selector.setSelectedIndex(indice);
          selector.onSelect = elegir;
          selector.onCancel = cancelar;
        } else {
          selector = new ListaMenu(visibles, () => Math.max(2, ui.terminal.rows - cabecera.render(ui.terminal.columns).length -
            (filtrar ? 6 : 5)), {
            activa: seleccion, elegir, cancelar,
            cambiar: (value) => { if (clave) selecciones.set(clave, value); },
          });
          if (opcionesDinamicas) refrescarSelector = () => selector.setItems(filasVisibles());
        }
        panel.addChild(cabecera);
        if (filtrar) {
          filtroSelector = "";
          filtroVisible.setText("Filtrar por ID");
          panel.addChild(filtroVisible);
        }
        panel.addChild(selector);
        render(estado);
      });
    },
    async formulario(titulo, campos, valores = {}) {
      const borrador = { ...valores };
      for (;;) {
        const opcion = await interfaz.elegir(titulo, [
          ...campos.map(({ id, label }) => ({ value: id, label,
            description: borrador[id]?.replaceAll("\n", ", ") || "Sin definir" })),
          { value: "guardar", label: "Guardar" },
          { value: "cancelar", label: "Cancelar" },
        ], undefined, { id: titulo });
        if (!opcion || opcion === "cancelar") return;
        if (opcion === "guardar") return borrador;
        const campo = campos.find(({ id }) => id === opcion);
        const entrada = await interfaz.preguntar(campo.ayuda ?? campo.label, borrador[opcion] ?? "");
        if (entrada !== undefined) borrador[opcion] = entrada;
      }
    },
    mostrarDetalle(texto, titulo = "Detalles de operación · Esc vuelve a la sesión") {
      if (cerrado) return Promise.resolve();
      return new Promise((resuelve) => {
        esperando = resuelve;
        detalle = texto;
        inspector.vista.scrollToStart();
        panel.addChild(new Text(acciones.limpiar(titulo), 1));
        render(estado);
      });
    },
    async consultar(texto, tarea, { cancelable = true } = {}) {
      if (cerrado) return;
      const controlador = new AbortController();
      consulta = { cancelable, controlador: cancelable ? controlador : undefined };
      detalle = texto;
      inspector.vista.scrollToStart();
      if (compatibilidad) panel.addChild(new Text("Esc cancela la consulta", 1));
      render(estado);
      try {
        const resultado = await tarea(controlador.signal);
        if (!controlador.signal.aborted) return resultado;
      } catch (error) {
        if (!controlador.signal.aborted) throw error;
      } finally {
        consulta = undefined;
        resolverEntrada(undefined);
      }
    },
    cerrar() {
      if (cerrado) return;
      cerrado = true;
      consulta?.controlador?.abort();
      secreto = undefined;
      esperando?.(undefined);
      ui.stop();
    },
  };
  return interfaz;
}
