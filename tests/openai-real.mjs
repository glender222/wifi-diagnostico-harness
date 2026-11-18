import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardarAlcance, idsAuditoria, leerAuditoria, leerJson, usarAdaptador } from "../proyecto.mjs";
import { ocultarClaveOpenAI } from "../proveedor-openai.mjs";
import { iniciarSesionAgente } from "../sesion-agente.mjs";

if (!process.env.OPENAI_API_KEY?.trim()) {
  console.log("Integración real omitida. OPENAI_API_KEY no está definida.");
} else {
  const [openaiModelId, extra] = process.argv.slice(2);
  if (!openaiModelId || extra) {
    console.error("Usa npm run test:openai -- <model-id> con un modelo disponible en /config modelos.");
    process.exitCode = 1;
  } else {
    await probar(openaiModelId);
  }
}

async function probar(openaiModelId) {
  const raiz = await mkdtemp(join(tmpdir(), "harwiff-openai-real-"));
  try {
    const proyecto = { raiz, config: { cliente: "demo", llm: { proveedor: "openai", openaiModelId } } };
    await guardarAlcance(proyecto, { allowedBssids: [], allowedSsids: ["LAB_TEST_AP"], allowedChannels: [6] });
    await usarAdaptador(proyecto, "mock");
    const item = await iniciarSesionAgente({ proyecto,
      objetivo: "Usa las herramientas del escenario sintético para comprobar la postura de LAB_TEST_AP y resume la evidencia." });
    await item.trabajo;
    const estado = await leerJson(join(item.dir, "sesion.json"));
    const auditorias = await Promise.all((await idsAuditoria(raiz)).map((id) => leerAuditoria(raiz, id)));
    const herramientas = auditorias.filter((registro) => registro.padre === estado.turnId && registro.autorizacion)
      .map(({ operacion, autorizacion, referenciasEvidencia }) => ({
        operacion, decision: autorizacion.decision, motivo: autorizacion.motivo,
        evidencias: referenciasEvidencia.map(({ id }) => id),
      }));
    console.log(JSON.stringify({ proveedor: estado.provider, modeloSolicitado: estado.modelId,
      estado: estado.status, motivo: estado.reason, consumo: estado.consumo, herramientas }, null, 2));
    if (estado.status !== "completed" || !herramientas.some(({ decision, evidencias }) => decision === "ALLOWED" && evidencias.length)
        || !estado.consumo?.tokens) process.exitCode = 1;
  } catch (error) {
    console.error(ocultarClaveOpenAI(error.message));
    process.exitCode = 1;
  } finally {
    await rm(raiz, { recursive: true, force: true });
  }
}
