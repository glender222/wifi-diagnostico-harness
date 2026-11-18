// Servidor simulado dentro del proceso de las pruebas de terminal.
globalThis.fetch = async (input, init) => {
  const solicitud = new Request(input, init);
  if (solicitud.headers.get("authorization") !== "Bearer sk-fixture-harwiff-terminal") {
    return Response.json({ error: { code: "invalid_api_key" } }, { status: 401 });
  }
  if (solicitud.url === "https://api.openai.com/v1/models") {
    return Response.json({ data: [{ id: "gpt-4.1-mini" }, { id: "gpt-5-mini" }] });
  }
  if (solicitud.url !== "https://api.openai.com/v1/responses") throw new Error("Ruta fuera del fixture");
  const { model, input: contexto, stream } = await solicitud.json();
  const usage = { input_tokens: 8, output_tokens: 2, total_tokens: 10 };
  const llamada = { type: "function_call", id: "fc_fixture", call_id: "call_fixture",
    name: "observar_entorno", arguments: "{}", status: "completed" };
  if (!stream) return Response.json({ status: "completed", model, usage, output: [llamada] });
  const recibio = contexto.some((item) => item.type === "function_call_output");
  const item = recibio ? { type: "message", id: "msg_fixture", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "Conclusión basada en el fixture simulado.", annotations: [] }] } : llamada;
  const respuesta = { id: recibio ? "resp_fixture_2" : "resp_fixture_1", model };
  const eventos = [
    { type: "response.created", response: { ...respuesta, status: "in_progress" } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { ...respuesta, status: "completed", usage, output: [item] } },
  ];
  return new Response(eventos.map((evento) => `event: ${evento.type}\ndata: ${JSON.stringify(evento)}\n\n`).join(""),
    { headers: { "Content-Type": "text/event-stream" } });
};
