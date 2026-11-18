import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
} finally {
  await chmod(restringido, 0o700).catch(() => {});
  await rm(temporal, { recursive: true, force: true });
}
