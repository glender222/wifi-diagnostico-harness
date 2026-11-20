// Servidor simulado dentro del proceso de las pruebas de terminal.
import { setTimeout as esperar } from "node:timers/promises";

globalThis.fetch = async (input, init) => {
  const solicitud = new Request(input, init);
  if (solicitud.headers.get("authorization") !== "Bearer sk-fixture-harwiff-terminal") {
    return Response.json({ error: { code: "invalid_api_key" } }, { status: 401 });
  }
  if (solicitud.url === "https://api.openai.com/v1/models") {
    return Response.json({ data: [{ id: "gpt-4.1-mini" }, { id: "gpt-5-mini" }] });
  }
  if (solicitud.url !== "https://api.openai.com/v1/responses") throw new Error("Ruta fuera del fixture");
  const { model, input: contexto, stream, tools } = await solicitud.json();
  const usage = { input_tokens: 8, output_tokens: 2, total_tokens: 10 };
  const catalogo = new Set(tools?.map(({ name }) => name));
  const operacion = catalogo.has("comprobar") ? "comprobar" :
    catalogo.has("inspeccionar_enlace") ? "inspeccionar_enlace" : "observar_entorno";
  const llamada = { type: "function_call", id: "fc_fixture", call_id: "call_fixture",
    name: operacion, arguments: operacion === "inspeccionar_enlace" ? '{"interfaz":"i1"}' : "{}", status: "completed" };
  if (!stream) return Response.json({ status: "completed", model, usage, output: [llamada] });
  const recibio = contexto.findLast((item) => item.type === "function_call_output");
  const pausa = Number(process.env.HARWIFF_FIXTURE_STREAM_DELAY);
  const seguimiento = contexto.some((item) => JSON.stringify(item).includes("Confirma lo que guardaste"));
  const fase = seguimiento ? "seguimiento" : "proveedor";
  const parcial = `Texto parcial del ${fase}.`;
  let texto = pausa ? `${parcial} Cierre del ${fase}.` : "Conclusión basada en el fixture simulado.";
  if (recibio && operacion === "comprobar") texto = JSON.stringify({ resultado: recibio.output });
  if (recibio && operacion === "inspeccionar_enlace") {
    const { ref } = JSON.parse(recibio.output).observations.find(({ field }) => field === "ipv4_route");
    texto = JSON.stringify({ version: 1, claims: [{ kind: "fact", refs: [ref] }] });
  }
  const item = recibio ? { type: "message", id: "msg_fixture", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: texto, annotations: [] }] } : llamada;
  const respuesta = { id: recibio ? "resp_fixture_2" : "resp_fixture_1", model };
  const eventos = [
    { type: "response.created", response: { ...respuesta, status: "in_progress" } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { ...respuesta, status: "completed", usage, output: [item] } },
  ];
  const headers = { "Content-Type": "text/event-stream" };
  const sse = (evento) => `event: ${evento.type}\ndata: ${JSON.stringify(evento)}\n\n`;
  if (!pausa || !recibio) return new Response(eventos.map(sse).join(""), { headers });
  const codificar = new TextEncoder();
  return new Response(new ReadableStream({
    async start(controller) {
      const enviar = (evento) => controller.enqueue(codificar.encode(sse(evento)));
      enviar(eventos[0]);
      enviar({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } });
      enviar({ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id,
        delta: parcial });
      await esperar(pausa);
      enviar(eventos[1]);
      enviar(eventos[2]);
      controller.close();
    },
  }), { headers });
};
