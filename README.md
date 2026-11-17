# Harness de diagnóstico Wi-Fi

El harness se instala en una carpeta independiente. Cada proyecto elige un cliente al crearse y conserva sus sesiones como archivos Markdown e informes JSON. El diagnóstico puede ejecutarse localmente o en OpenSandbox.

## Abrir Harwiff

Se usa Linux, Node.js 22.19 o posterior y Python 3.10 o posterior.

Desde el repositorio, instala Harwiff una vez:

```bash
npm ci --ignore-scripts
mkdir -p "$HOME/.local/bin"
ln -s "$PWD/consola.mjs" "$HOME/.local/bin/harwiff"
```

Con `$HOME/.local/bin` en tu `PATH`, ejecuta `harwiff` desde una carpeta que contenga `harness.json`. Puedes abrir otra carpeta con `harwiff ruta/al/proyecto`. Si ejecutas `harwiff` fuera de un proyecto, el asistente pregunta qué carpeta abrir y qué cliente usar al crearla. Cada proyecto conserva el cliente registrado en `harness.json`.

Dentro de la aplicación:

| Comando | Acción |
| --- | --- |
| `/ayuda` | Ver los comandos y sus argumentos. Tab completa los nombres. |
| `/nueva revision Revisar la conexión` | Crear y abrir una sesión con ese objetivo. |
| `/sesiones` · `/abrir revision` | Ver y retomar sesiones guardadas. |
| `/diagnostico demo` · `/diagnostico` | Guardar una muestra sintética o un diagnóstico de la conexión activa. |
| `/guardar texto` | Añadir una nota fechada. |
| `/contexto` | Leer o copiar el objetivo, las reglas, los informes y la conversación guardada. |
| `/config` | Ver el cliente y el motor. `/config local` y `/config opensandbox` guardan el motor. |
| `/salir` | Cerrar la aplicación. |

### Conversar en la aplicación

Para un proyecto creado con **Azure Foundry**, configura el dominio y el nombre del deployment con `/config recurso.openai.azure.com nombre-del-deployment`. Proporciona `FOUNDRY_API_KEY` en el entorno antes de arrancar. El deployment debe admitir Chat Completions v1 y llamadas a herramientas. Con una sesión abierta, escribe una consulta en texto normal. La herramienta del agente lee únicamente el contexto de esa sesión. [Referencia de Chat Completions](https://learn.microsoft.com/en-us/azure/foundry/openai/latest)

Para los proyectos de **OpenCode** o **ChatGPT**, la conversación ocurre en el cliente elegido. Si el agente accede a la carpeta, puede leer `AGENTS.md` y trabajar con los archivos de la sesión. Cuando trabaja solo con texto, comparte la salida de `/contexto` y añade la nota que devuelva con `/guardar`.

### Qué queda en la carpeta

- `OBJETIVO.md`, `REGISTRO.md` e `informes/` guardan el objetivo, los avances fechados y los informes. [Ejemplo de informe](ejemplos/informe-demo.json)
- `turnos/` guarda la consulta antes de llamar a Foundry y el resultado al finalizar. Cada resultado conserva mensajes y respuestas de herramientas. Los turnos completos vuelven al contexto del agente al retomar la sesión. Si una ejecución se interrumpe, `/contexto` muestra la consulta pendiente para que puedas reenviarla.
- El código del loop se tomó de [Pi v1.5.2](vendor/pi/README.md). La aplicación arranca con su propia consola y sus reglas de sesión. El recolector de diagnóstico sigue disponible para automatizaciones mediante `app.py`.

## Diagnóstico y OpenSandbox

`python3 app.py diagnosticar revision` usa NetworkManager en Linux para leer la conexión activa. El informe incluye el número de interfaces, el estado de conexión, la señal y la presencia de configuración IP, gateway y DNS. Omite identificadores, direcciones y claves. El alcance a Internet y la resolución DNS quedan sin medir. Si hay varias interfaces activas, usa `--interfaz NOMBRE`.

Con un servidor OpenSandbox disponible, instala `requirements-opensandbox.txt` en un entorno virtual y arranca la aplicación con `WIFI_PYTHON` apuntando al ejecutable Python de ese entorno. Dentro de la aplicación selecciona `/config opensandbox`. El valor por defecto del servidor es `http://127.0.0.1:8090`. Revisa `OPENSANDBOX_DOMAIN`, `OPENSANDBOX_PROTOCOL` y `OPENSANDBOX_API_KEY` según la instalación.

El sandbox recibe el analizador fijo y la muestra depurada, y se elimina al terminar. [SDK de Python](https://open-sandbox.ai/sdks/python)
