# Harness de diagnóstico Wi-Fi

El harness se instala en una carpeta independiente. Cada proyecto elige un cliente al crearse y conserva sus sesiones como archivos Markdown e informes JSON. El diagnóstico puede ejecutarse localmente o en OpenSandbox.

## Iniciar un proyecto

Clona el repositorio en Linux con Python 3.10 o posterior:

```bash
git clone https://github.com/glender222/wifi-diagnostico-harness.git
cd wifi-diagnostico-harness
python3 app.py iniciar ../mi-proyecto --cliente chatgpt
cd ../mi-proyecto
python3 app.py nueva revision --objetivo "Revisar el estado de la conexión Wi-Fi"
python3 app.py abrir revision
```

El instalador también acepta una carpeta vacía. Elige `chatgpt`, `opencode` o `azure-foundry` al crearla. `harness.json` registra esa elección y `AGENTS.md` contiene las reglas de trabajo. Las sesiones se guardan en `sesiones/ID/` con `OBJETIVO.md`, `REGISTRO.md` e `informes/`.

## Trabajar y retomar

```bash
python3 app.py sesiones
python3 app.py diagnosticar revision --demo
python3 app.py guardar revision --nota "Qué hice: probé la demo. Evidencia: informe sintético. Próximo paso: ejecutar la lectura local."
python3 app.py abrir revision
```

Con un agente que tenga acceso a archivos, abre la carpeta del proyecto y pídele que lea `AGENTS.md` y retome la sesión `revision`. El agente puede consultar el historial y guardar avances con `app.py guardar`. Para cambiar de sesión, guarda el avance actual y abre el nuevo ID.

Cuando el chat no tenga acceso a la carpeta, copia la salida de `abrir revision` en el chat. Guarda la nota Markdown que te devuelva con `python3 app.py guardar revision --archivo nota.md`. El historial de la carpeta queda disponible aunque empieces otro chat.

Si el proyecto se creó con `azure-foundry`, `python3 app.py explicar revision` envía el contexto al deployment configurado y devuelve una nota propuesta. Configura `FOUNDRY_HOST` con el dominio del recurso, `FOUNDRY_DEPLOYMENT` con el nombre del deployment y `FOUNDRY_API_KEY` con su clave. El deployment debe admitir Chat Completions v1. [Referencia de Chat Completions](https://learn.microsoft.com/en-us/azure/foundry/openai/latest)

## Diagnóstico y OpenSandbox

`python3 app.py diagnosticar revision` usa NetworkManager en Linux para leer la conexión activa. El informe incluye el número de interfaces, el estado de conexión, la señal y la presencia de configuración IP, gateway y DNS. Omite identificadores, direcciones y claves. El alcance a Internet y la resolución DNS quedan sin medir. Si hay varias interfaces activas, usa `--interfaz NOMBRE`.

Con un servidor OpenSandbox disponible, ejecuta desde la carpeta de tu proyecto:

```bash
python3 -m venv .venv
.venv/bin/pip install -r harness/requirements-opensandbox.txt
.venv/bin/python app.py diagnosticar revision --motor opensandbox --demo
```

El valor por defecto es `http://127.0.0.1:8090`. Configura `OPENSANDBOX_DOMAIN` y `OPENSANDBOX_PROTOCOL` si usas otro servidor. Configura `OPENSANDBOX_API_KEY` cuando el servidor requiera autenticación. El sandbox recibe el analizador fijo y la muestra depurada, y se elimina al terminar. Si el servidor tiene el componente de egreso configurado, `--denegar-egreso` solicita una política restrictiva. [SDK de Python](https://open-sandbox.ai/sdks/python) · [Políticas de egreso](https://open-sandbox.ai/guides/network-security)

## Estado de la versión 0.1.0

- `OBJETIVO.md` registra el objetivo. `REGISTRO.md` conserva las notas con fecha UTC y las referencias a los informes. `informes/` guarda cada lectura depurada o muestra sintética por separado. [Ejemplo de informe](ejemplos/informe-demo.json)
- El flujo actual se ejecuta por pasos. Abre la sesión, lee el contexto, realiza el diagnóstico o registra el trabajo, guarda la nota y vuelve a abrir la sesión cuando quieras continuar.
- Queda pendiente definir y validar el loop del agente, incluyendo qué eventos registra, cuándo hace un checkpoint y cómo reanuda una ejecución que se interrumpió. Las notas de esta versión se guardan por comando y pueden leerse desde otro chat o proceso.
