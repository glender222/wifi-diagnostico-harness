import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crearCredencialesOpenAI } from "../credenciales-openai.mjs";
import { cargarObjetivosMock } from "../policy.mjs";
import { guardarAlcance, idsAuditoria, leerAuditoria, leerJson, usarAdaptador } from "../proyecto.mjs";
import { comprobarHerramientasOpenAI, ocultarClaveOpenAI } from "../proveedor-openai.mjs";
import { iniciarSesionAgente } from "../sesion-agente.mjs";

const credenciales = await crearCredencialesOpenAI().resolver();
if (!credenciales.fuente) {
  console.log("Integración real omitida. No hay una credencial de OpenAI en OPENAI_API_KEY ni en Secret Service.");
} else {
  const [openaiModelId, extra] = process.argv.slice(2);
  if (!openaiModelId || extra) {
    console.error("Usa npm run test:openai -- <model-id> con un modelo disponible en /config modelos.");
    process.exitCode = 1;
  } else {
    await probar(openaiModelId, credenciales.entorno);
  }
}

async function probar(openaiModelId, entorno) {
  const raiz = await mkdtemp(join(tmpdir(), "harwiff-openai-real-"));
  try {
    const conectividad = await comprobarHerramientasOpenAI(openaiModelId, { entorno });
    console.log(JSON.stringify({ conectividad }, null, 2));
    const proyecto = { raiz, config: { cliente: "demo", llm: { proveedor: "openai", openaiModelId } } };
    await guardarAlcance(proyecto, { allowedBssids: [], allowedSsids: ["LAB_TEST_AP"], allowedChannels: [6] });
    await usarAdaptador(proyecto, "mock");
    const item = await iniciarSesionAgente({ proyecto, entornoLlm: entorno,
      objetivo: "Investiga autónomamente la postura de seguridad del punto de acceso autorizado LAB_TEST_AP. " +
        "Selecciona las herramientas que consideres necesarias, analiza sus resultados, identifica posibles riesgos y " +
        "registra hallazgos solamente cuando tengas evidencia suficiente. Distingue claramente los datos observados " +
        "de tus hipótesis y finaliza con conclusiones justificadas." });
    await item.trabajo;
    const estado = await leerJson(join(item.dir, "sesion.json"));
    const eventos = await leerJson(join(item.dir, "turnos", estado.turnId, "eventos.json"));
    const auditorias = await Promise.all((await idsAuditoria(raiz)).map((id) => leerAuditoria(raiz, id)));
    const porId = new Map(auditorias.map((registro) => [registro.id, registro]));
    const herramientas = eventos.filter((evento) => evento.type === "tool_result").map((evento) => {
      const { operacion, autorizacion, referenciasEvidencia } = porId.get(evento.auditId);
      return { operacion, decision: autorizacion.decision, motivo: autorizacion.motivo,
        evidencias: referenciasEvidencia.map(({ id }) => id) };
    });
    const primeraEvidencia = eventos.findIndex((evento) => evento.type === "tool_result"
      && evento.autorizacion?.decision === "ALLOWED" && evento.referenciasEvidencia.length);
    const iteroConEvidencia = primeraEvidencia >= 0 && eventos.slice(primeraEvidencia + 1).some(({ type }) => type === "request");
    const permitidos = await cargarObjetivosMock(estado.snapshot.scope);
    const referencias = eventos.flatMap((evento) => evento.referenciasEvidencia ?? []);
    const evidencia = await Promise.all(referencias.map(({ referencia }) => leerJson(join(raiz, referencia))));
    const evidenciaEnAlcance = evidencia.length > 0 && evidencia.every((registro) =>
      registro.sessionId === estado.id && registro.scopeId === estado.scopeId
      && registro.bssids.every((bssid) => permitidos.has(bssid)));
    const limite = estado.snapshot.scope.maxIterations;
    const limitesRespetados = estado.iteration <= limite && estado.toolAttempts <= limite;
    const explicaciones = eventos.filter(({ type }) => type === "response").map(({ text }) => text);
    console.log(JSON.stringify({ proveedor: estado.provider, modeloSolicitado: estado.modelId,
      estado: estado.status, motivo: estado.reason, iteraciones: estado.iteration, iteroConEvidencia,
      evidenciaEnAlcance, limitesRespetados, consumo: estado.consumo, herramientas, explicaciones }, null, 2));
    if (estado.provider !== "openai" || estado.status !== "completed" || estado.reason !== "completed"
        || !iteroConEvidencia || !evidenciaEnAlcance || !limitesRespetados
        || !explicaciones.length || !estado.consumo?.tokens) process.exitCode = 1;
  } catch (error) {
    console.error(ocultarClaveOpenAI(error.message, entorno));
    process.exitCode = 1;
  } finally {
    await rm(raiz, { recursive: true, force: true });
  }
}
