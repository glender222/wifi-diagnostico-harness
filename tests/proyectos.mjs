import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { conBloqueoProyecto } from "../entorno.mjs";
import { buildScopeSnapshot, guardarAlcance, leerAuditoria, leerControlWifi, localizarProyecto } from "../proyecto.mjs";

const consola = fileURLToPath(new URL("../consola.mjs", import.meta.url));
const temporal = await mkdtemp(join(tmpdir(), "harwiff-descubrir-"));
const raiz = join(temporal, "Área de trabajo");
const plano = join(raiz, "a legado");
const actual = join(raiz, "b actual");
const anidado = join(raiz, "temas", "c anidado");
const ajeno = join(raiz, "d ajeno");
const danado = join(raiz, "e roto");
const restringido = join(raiz, "f restringido");
const externo = join(temporal, "fuera");
const vacio = join(temporal, "vacío");

async function manifiesto(ruta, cliente = "demo") {
  await mkdir(dirname(ruta), { recursive: true });
  await writeFile(ruta, JSON.stringify({ esquema: "wifi-proyecto/v1", cliente }));
}

function cli(...args) {
  return spawnSync(process.execPath, [consola, ...args], {
    cwd: raiz, encoding: "utf8", env: { ...process.env, WIFI_PYTHON: "/fixture/no-existe" },
  });
}

function consolaConEntrada(carpeta, ...comandos) {
  const resultado = spawnSync(process.execPath, [consola, carpeta], {
    cwd: raiz, encoding: "utf8", input: [...comandos, "/salir", ""].join("\n"),
  });
  assert.equal(resultado.status, 0, resultado.stderr);
  return resultado.stdout;
}

try {
  await manifiesto(join(raiz, ".harwiff/harness.json"));
  await manifiesto(join(plano, "harness.json"), "chatgpt");
  await manifiesto(join(actual, "harness.json"), "opencode");
  await manifiesto(join(actual, ".harwiff/harness.json"), "azure-foundry");
  await manifiesto(join(anidado, ".harwiff/harness.json"));
  await manifiesto(join(raiz, ".oculto", "harness.json"));
  await manifiesto(join(raiz, "node_modules", "harness.json"));
  await manifiesto(join(raiz, "g enlaces", "legado", "harness.json"));
  await manifiesto(join(externo, "harness.json"));
  await mkdir(ajeno);
  await writeFile(join(ajeno, "harness.json"), '{"app":"otro"}');
  await mkdir(join(danado, ".harwiff"), { recursive: true });
  await writeFile(join(danado, ".harwiff/harness.json"), "{");
  await mkdir(restringido);
  await mkdir(vacio);
  await symlink(externo, join(raiz, "h enlace"));
  await symlink(externo, join(raiz, "g enlaces/.harwiff"));
  await symlink(join(externo, "harness.json"), join(raiz, "g enlaces/harness.json"));

  if (process.getuid() !== 0) await chmod(restringido, 0o000);
  const normal = cli("proyectos", "--json");
  assert.equal(normal.status, 0, normal.stderr);
  assert.equal(normal.stderr, "");
  const datos = JSON.parse(normal.stdout);
  assert.equal(datos.ruta, raiz);
  assert.deepEqual(datos.proyectos, [
    { nombre: "Área de trabajo", ruta: raiz, cliente: "demo" },
    { nombre: "a legado", ruta: plano, cliente: "chatgpt" },
    { nombre: "b actual", ruta: actual, cliente: "azure-foundry" },
  ]);
  assert.ok(datos.avisos.some(({ ruta, motivo }) => ruta === danado && /manifiesto/.test(motivo)));
  if (process.getuid() !== 0) {
    assert.ok(datos.avisos.some(({ ruta }) => ruta === restringido));
    assert.equal(cli("proyectos", restringido).status, 1);
  }

  const profundo = JSON.parse(cli("proyectos", raiz, "--profundidad", "2", "--json").stdout);
  assert.ok(profundo.proyectos.some(({ ruta }) => ruta === anidado));
  assert.ok(!profundo.proyectos.some(({ ruta }) => ruta === externo || ruta.includes("/node_modules/")));
  assert.equal(JSON.parse(cli("proyectos", "--profundidad=0", "--json", raiz).stdout).proyectos.length, 1);
  assert.equal(cli("proyectos", "--profundidad", "6").status, 1);
  assert.equal(cli("proyectos", join(raiz, "desconocido")).status, 1);
  assert.equal(cli("proyectos", join(raiz, "h enlace")).status, 1);
  const texto = cli("proyectos", raiz);
  assert.ok(texto.stdout.includes(`b actual · azure-foundry · ${actual}`));
  assert.ok(texto.stderr.includes("Aviso:"));
  const sinResultados = cli("proyectos", "--json", vacio);
  assert.equal(sinResultados.status, 0);
  assert.deepEqual(JSON.parse(sinResultados.stdout), { ruta: vacio, proyectos: [], avisos: [] });
  assert.deepEqual(await readdir(vacio), []);
  const hogar = cli("proyectos", "--json", "--profundidad", "0", "~");
  assert.equal(hogar.status, 0, hogar.stderr);
  assert.equal(JSON.parse(hogar.stdout).ruta, homedir());
  console.log("Descubrimiento, JSON y errores de ruta verificados.");

  const proyecto = await localizarProyecto(actual);
  const alcance = {
    allowedBssids: ["AA:BB:CC:11:22:33"],
    allowedSsids: ["  Área de pruebas  ", 'Red "B"'],
    allowedChannels: [1, 6],
    maxIterations: 8,
  };
  assert.match(consolaConEntrada(actual, "/adaptador usar mock"), /Define al menos un BSSID o SSID/);
  assert.equal((await leerControlWifi(proyecto)).adapter, null);
  const salida = consolaConEntrada(actual, "/adaptador listar",
    String.raw`/alcance set --bssid aa:bb:cc:11:22:33 --bssid AA:BB:CC:11:22:33 --ssid "  Área de pruebas  " --ssid "Red \"B\"" --canales 1,6,6`,
    "/adaptador usar mock", "/alcance ver", "/diagnostico");
  assert.match(salida, /mock · simulado · disponible/);
  assert.match(salida, /Adaptador seleccionado: mock · Preflight: OK/);
  assert.match(salida, /"preflightPassed": true/);
  assert.match(salida, /Informe guardado/);

  const estado = await leerControlWifi(proyecto);
  const snapshot = await buildScopeSnapshot(await localizarProyecto(actual));
  assert.deepEqual(snapshot, {
    projectId: estado.projectId,
    adapter: { name: "mock", mode: "mock", lockedBySession: null },
    scope: alcance,
    preflightPassed: true,
  });
  for (const objeto of [snapshot, snapshot.adapter, snapshot.scope,
    snapshot.scope.allowedBssids, snapshot.scope.allowedSsids, snapshot.scope.allowedChannels]) {
    assert.ok(Object.isFrozen(objeto));
  }
  assert.throws(() => snapshot.scope.allowedSsids.push("otra red"), TypeError);
  assert.match(consolaConEntrada(actual, "/alcance ver", "/alcance set --bssid invalido",
    "/alcance set --canales 1", '/alcance set --ssid "sin cerrar', "/adaptador usar inexistente"), /BSSID inválido/);
  assert.deepEqual(await leerControlWifi(proyecto), estado);
  assert.match(consolaConEntrada(actual, "/alcance ver"), new RegExp(estado.projectId));
  await conBloqueoProyecto(proyecto.raiz, async () => {
    await assert.rejects(guardarAlcance(proyecto, { ...alcance, allowedSsids: ["Otra"] }), /Otra consola/);
  });
  assert.deepEqual(await leerControlWifi(proyecto), estado);

  const rutaEstado = join(proyecto.raiz, "control-wifi.json");
  await writeFile(rutaEstado, JSON.stringify({ ...estado, scope: { ...alcance, allowedBssids: [], allowedSsids: [] } }));
  await assert.rejects(buildScopeSnapshot(proyecto), (error) =>
    error.preflight?.ok === false && error.preflight.errors.some((motivo) => /al menos/.test(motivo)));
  assert.match(consolaConEntrada(actual, "/alcance ver"), /"snapshot": null/);

  const legado = await localizarProyecto(plano);
  await writeFile(legado.archivo, JSON.stringify({ ...legado.config, adaptador: "a".repeat(20) }));
  const migrado = await leerControlWifi(await localizarProyecto(plano));
  assert.deepEqual(migrado.adapter, { id: "a".repeat(20), name: null, mode: "sandbox" });
  assert.equal(migrado.snapshot, null);
  assert.match(consolaConEntrada(plano, "/diagnostico", "/auditoria"), /diagnostico · bloqueado/);
  const [ejecucion] = await readdir(join(legado.raiz, "auditoria"));
  const auditoria = await leerAuditoria(legado.raiz, ejecucion);
  assert.equal(auditoria.decision, "denegado");
  assert.match(auditoria.motivo, /al menos un BSSID o SSID/);
  await assert.rejects(readFile(join(legado.raiz, "informes", `${ejecucion}.json`)), { code: "ENOENT" });
  console.log("Alcance, selección, bloqueo de configuración, migración y snapshot verificados.");
} finally {
  await chmod(restringido, 0o700).catch(() => {});
  await rm(temporal, { recursive: true, force: true });
}
