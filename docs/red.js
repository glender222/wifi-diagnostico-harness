const escena = document.querySelector(".red-visual");
const lienzo = escena.querySelector("canvas");
const control = document.querySelector("#control-red");
const contexto = lienzo.getContext("2d");

if (contexto) {
  const preferencia = matchMedia("(prefers-reduced-motion: reduce)");
  const nodos = [
    [-1.05, .66, -.20, .72], [-.74, .44, .30, .86], [-.29, .27, -.35, .72],
    [-.49, -.16, .10, .70], [-.04, -.27, .42, .98], [.22, -.02, .52, 1.35],
    [.26, .42, .25, .94], [.57, .25, -.20, .64], [.70, -.02, .24, 1.10],
    [.57, -.52, .31, 1.18], [.38, -.72, -.38, .55], [.81, -.70, -.05, .70],
    [.97, -.37, -.28, .51], [.93, .40, -.31, .57], [.32, .73, -.16, .54],
    [-.21, .69, -.42, .45], [-.76, -.40, -.48, .47], [.11, -.58, -.40, .56],
  ];
  // La curvatura sigue a los dos nodos a medida que se mueven.
  const enlaces = [
    [0, 1, -.10], [0, 5, -.24], [0, 6, -.15], [1, 2, -.18], [1, 5, -.18],
    [2, 4, .16], [2, 5, -.13], [3, 4, -.18], [3, 16, .22], [4, 5, -.17],
    [4, 9, -.24], [4, 17, .18], [5, 6, -.21], [5, 8, .23], [5, 9, .18],
    [5, 11, .20], [5, 14, -.20], [6, 7, -.14], [6, 14, .14], [6, 15, .19],
    [7, 8, .15], [7, 13, -.19], [8, 9, -.20], [8, 12, .17], [8, 13, -.19],
    [9, 10, .14], [9, 11, .18], [10, 17, .20], [11, 12, -.13],
  ];
  let ancho = 0;
  let alto = 0;
  let tiempo = 0;
  let anterior;
  let frame = 0;
  let visible = true;
  let pausa = preferencia.matches;
  let iniciado = false;
  let miraX = 0;
  let miraY = 0;
  let giroX = 0;
  let giroY = 0;
  let posiciones = [];
  let arrastre;
  const desplazamientos = nodos.map(() => ({ x: 0, y: 0 }));

  function medir() {
    const caja = escena.getBoundingClientRect();
    ancho = caja.width;
    alto = caja.height;
    const densidad = Math.min(devicePixelRatio, 1.6);
    lienzo.width = Math.round(ancho * densidad);
    lienzo.height = Math.round(alto * densidad);
    contexto.setTransform(densidad, 0, 0, densidad, 0, 0);
    if (iniciado && ancho && alto) dibujar();
    sincronizar();
  }

  function proyectar([baseX, baseY, baseZ, luz], indice) {
    const fase = indice * 1.83;
    const offset = desplazamientos[indice];
    const x = baseX + offset.x + Math.sin(tiempo * .47 + fase) * .14;
    const y = baseY + offset.y + Math.cos(tiempo * .55 - fase) * .10;
    const z = baseZ + Math.sin(tiempo * .59 + fase) * .24;
    const lateral = giroY + Math.sin(tiempo * .31) * .20;
    const vertical = giroX + Math.cos(tiempo * .26) * .14;

    const rotadoX = x * Math.cos(lateral) + z * Math.sin(lateral);
    const fondo = z * Math.cos(lateral) - x * Math.sin(lateral);
    const rotadoY = y * Math.cos(vertical) - fondo * Math.sin(vertical);
    const profundidad = y * Math.sin(vertical) + fondo * Math.cos(vertical);
    const perspectiva = 3.1 / (3.1 - profundidad);
    return {
      x: ancho * (.51 + rotadoX * .44 * perspectiva),
      y: alto * (.49 + rotadoY * .50 * perspectiva),
      z: profundidad,
      brillo: luz * perspectiva,
    };
  }

  function estela(a, b, curva, indice) {
    const sx = b.x - a.x;
    const sy = b.y - a.y;
    const cx = (a.x + b.x) / 2 - sy * curva;
    const cy = (a.y + b.y) / 2 + sx * curva;
    const fuerza = Math.min(1, (a.brillo + b.brillo) / 2);
    const linea = contexto.createLinearGradient(a.x, a.y, b.x, b.y);
    linea.addColorStop(0, "rgba(130, 165, 246, .17)");
    linea.addColorStop(.53, "rgba(164, 198, 255, " + (.34 * fuerza) + ")");
    linea.addColorStop(1, "rgba(223, 237, 255, " + (.58 * fuerza) + ")");
    contexto.beginPath();
    contexto.moveTo(a.x, a.y);
    contexto.quadraticCurveTo(cx, cy, b.x, b.y);
    contexto.lineWidth = .65 + fuerza * .46;
    contexto.strokeStyle = linea;
    contexto.stroke();

    const t = (tiempo * (.16 + (indice % 4) * .032) + indice * .219) % 1;
    const origen = Math.max(0, t - .15);
    const px = u => (1 - u) ** 2 * a.x + 2 * (1 - u) * u * cx + u ** 2 * b.x;
    const py = u => (1 - u) ** 2 * a.y + 2 * (1 - u) * u * cy + u ** 2 * b.y;
    const rastro = contexto.createLinearGradient(px(origen), py(origen), px(t), py(t));
    rastro.addColorStop(0, "rgba(166, 187, 255, 0)");
    rastro.addColorStop(1, "rgba(218, 234, 255, " + (.84 * fuerza * Math.sin(Math.PI * t) ** .6) + ")");
    contexto.beginPath();
    contexto.moveTo(px(origen), py(origen));
    for (let tramo = 1; tramo <= 5; tramo++) {
      const u = origen + (t - origen) * tramo / 5;
      contexto.lineTo(px(u), py(u));
    }
    contexto.lineWidth = 1.4;
    contexto.strokeStyle = rastro;
    contexto.stroke();
  }

  function iluminar(nodo) {
    const alcance = Math.max(13, Math.min(alto, ancho) * .048) * nodo.brillo;
    const halo = contexto.createRadialGradient(nodo.x, nodo.y, 0, nodo.x, nodo.y, alcance);
    halo.addColorStop(0, "rgba(236, 246, 255, .96)");
    halo.addColorStop(.12, "rgba(149, 193, 255, .58)");
    halo.addColorStop(.38, "rgba(104, 156, 255, .16)");
    halo.addColorStop(1, "rgba(98, 146, 255, 0)");
    contexto.fillStyle = halo;
    contexto.fillRect(nodo.x - alcance, nodo.y - alcance, alcance * 2, alcance * 2);
    contexto.beginPath();
    contexto.arc(nodo.x, nodo.y, .9 + nodo.brillo * 1.75, 0, 2 * Math.PI);
    contexto.fillStyle = "#edf6ff";
    contexto.fill();
  }

  function dibujar() {
    contexto.clearRect(0, 0, ancho, alto);
    posiciones = nodos.map(proyectar);
    for (const [indice, [a, b, curva]] of enlaces.entries()) {
      estela(posiciones[a], posiciones[b], curva, indice);
    }
    for (const nodo of [...posiciones].sort((a, b) => a.z - b.z)) iluminar(nodo);
  }

  function animar(marca) {
    if (anterior !== undefined) tiempo += Math.min(.08, (marca - anterior) / 1000);
    anterior = marca;
    giroX += (miraX - giroX) * .065;
    giroY += (miraY - giroY) * .065;
    dibujar();
    frame = requestAnimationFrame(animar);
  }

  function sincronizar() {
    if (pausa || !visible || document.hidden || !ancho || !alto) {
      cancelAnimationFrame(frame);
      frame = 0;
      anterior = undefined;
      return;
    }
    if (!frame) {
      iniciado = true;
      escena.classList.add("con-movimiento");
      frame = requestAnimationFrame(animar);
    }
  }

  function actualizarPausa(valor) {
    pausa = valor;
    if (pausa) terminarArrastre();
    control.textContent = valor ? "Animar red" : "Pausar red";
    sincronizar();
  }

  const portada = escena.closest(".portada");

  function nodoCercano(evento) {
    const caja = escena.getBoundingClientRect();
    let cerca = -1;
    let distancia = 18;
    for (const [indice, nodo] of posiciones.entries()) {
      const radio = Math.hypot(nodo.x + caja.left - evento.clientX, nodo.y + caja.top - evento.clientY);
      if (radio < distancia) {
        distancia = radio;
        cerca = indice;
      }
    }
    return cerca;
  }

  function terminarArrastre() {
    if (arrastre && portada.hasPointerCapture(arrastre.id)) portada.releasePointerCapture(arrastre.id);
    arrastre = undefined;
    portada.classList.remove("nodo-cercano", "moviendo-nodo");
  }

  portada.addEventListener("pointerdown", (evento) => {
    if (pausa || evento.pointerType !== "mouse" || evento.button !== 0 ||
        evento.target.closest("a, button, h1, p, pre")) return;
    const indice = nodoCercano(evento);
    if (indice < 0) return;
    evento.preventDefault();
    arrastre = { id: evento.pointerId, indice, x: evento.clientX, y: evento.clientY };
    portada.setPointerCapture(evento.pointerId);
    portada.classList.add("moviendo-nodo");
  });

  portada.addEventListener("pointermove", (evento) => {
    if (evento.pointerType !== "mouse" || pausa) return;
    if (arrastre?.id === evento.pointerId) {
      const offset = desplazamientos[arrastre.indice];
      offset.x = Math.min(.65, Math.max(-.65, offset.x + (evento.clientX - arrastre.x) / (ancho * .44)));
      offset.y = Math.min(.65, Math.max(-.65, offset.y + (evento.clientY - arrastre.y) / (alto * .50)));
      arrastre.x = evento.clientX;
      arrastre.y = evento.clientY;
      return;
    }
    const interactivo = evento.target.closest("a, button, h1, p, pre");
    portada.classList.toggle("nodo-cercano", !interactivo && nodoCercano(evento) >= 0);
    const caja = portada.getBoundingClientRect();
    miraX = ((evento.clientY - caja.top) / caja.height - .5) * -.44;
    miraY = ((evento.clientX - caja.left) / caja.width - .5) * .64;
  });
  portada.addEventListener("pointerleave", () => {
    miraX = 0;
    miraY = 0;
    portada.classList.remove("nodo-cercano");
  });
  portada.addEventListener("pointerup", terminarArrastre);
  portada.addEventListener("pointercancel", terminarArrastre);
  portada.addEventListener("lostpointercapture", terminarArrastre);
  control.addEventListener("click", () => actualizarPausa(!pausa));
  preferencia.addEventListener("change", ({ matches }) => actualizarPausa(matches));
  document.addEventListener("visibilitychange", sincronizar);
  new ResizeObserver(medir).observe(escena);
  new IntersectionObserver(([entrada]) => {
    visible = entrada.isIntersecting;
    sincronizar();
  }).observe(escena);
  control.hidden = false;
  actualizarPausa(pausa);
}
