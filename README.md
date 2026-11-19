# Harwiff

Harwiff es un entorno de diagnóstico Wi-Fi por proyecto. Guarda las lecturas de solo lectura, notas e historial del agente y vincula cada operación con su evidencia.

## Instalar en Linux x86-64

```bash
curl -fsSL https://github.com/glender222/wifi-diagnostico-harness/releases/download/v0.2.6/install.sh | bash
```

El instalador verifica el SHA-256 y coloca el comando en `~/.local/bin/harwiff`. Si esa carpeta no está en tu `PATH`, lanza `~/.local/bin/harwiff` o añade `~/.local/bin` al `PATH`. La release incluye Node.js, Python, el loop de Pi y el servidor y SDK de OpenSandbox. El diagnóstico real requiere Docker operativo, NetworkManager e iproute2. [GitHub Releases](https://github.com/glender222/wifi-diagnostico-harness/releases)

## Abrir un proyecto

La instalación de Harwiff se reutiliza en todas tus carpetas. Crea o elige una carpeta de trabajo y ejecuta el comando desde allí.

```bash
mkdir -p ~/laboratorio-wifi
cd ~/laboratorio-wifi
harwiff
```

En la primera apertura, Harwiff muestra la ruta completa y ofrece **Inicializar aquí**. **Ahora no** y **Esc** dejan esa carpeta intacta. Puedes inicializarla más tarde con `/init` desde `harwiff >`. En una entrada por tubería, envía `/init` explícitamente. Para otra carpeta, usa `harwiff <ruta>` o `/proyecto <ruta>` desde Harwiff.

Los proyectos nuevos guardan sus datos y reglas en `.harwiff/` y usan las dependencias de la instalación. Al volver, Harwiff abre la carpeta indicada o la carpeta actual directamente. Una subcarpeta es un proyecto independiente. Los proyectos con un `harness.json` de Harwiff en la raíz siguen abriendo con sus datos en el mismo sitio.

## Probar las dos capas

- En **Capa 1** (`harwiff >`), elige el alcance y el adaptador. Los proyectos nuevos empiezan con el modelo pendiente. Usa `/connect` para conectar un proveedor y `/model` para elegir o cambiar el modelo del proyecto con las flechas y **Enter**. `/diagnostico demo` genera un informe sintético que aparece en `/auditoria`.
- En **Capa 2**, `/agente <objetivo>` inicia una sesión sobre el escenario mock. Usa **Tab**, las flechas y **Enter** para abrir la sesión. **Esc** o `/salir` vuelven a Capa 1. `/detener` cancela el turno.
- En Capa 1, `/salir` cierra Harwiff. Al reabrir la carpeta se recuperan los ajustes, las sesiones y los últimos seis registros de auditoría. El historial conversacional se carga al entrar en la sesión.

Para gestionar las notas manuales de una sesión de trabajo, usa `/nueva`, `/abrir`, `/guardar` y `/contexto`. Escribe `/` para ver los comandos de la vista actual.

## Listar y abrir proyectos por ruta

```bash
harwiff proyectos .
harwiff proyectos --json "$HOME/Proyectos"
harwiff proyectos --profundidad 2 "$HOME/Proyectos"
```

Desde `harwiff >`, escribe `/proyectos` o `/proyectos ~/Proyectos`. Usa las flechas para elegir, Enter para abrir y Esc para volver. El selector indica el proyecto activo. Para una ruta con espacios, escríbela directamente después de `/proyectos`.

Los dos listados revisan por defecto la propia carpeta y sus hijas inmediatas. `--profundidad 0` revisa solo la carpeta indicada y `--profundidad` admite hasta cinco niveles. Reconocen los proyectos con `.harwiff/harness.json` y los manifiestos anteriores en la raíz. Desde Bash, `--json` devuelve `ruta`, `proyectos` y `avisos`. Si tu carpeta se llama literalmente `proyectos`, ábrela con `harwiff ./proyectos`.

## Adaptador y alcance

Desde `harwiff >`, guarda primero el alcance con `/alcance set --ssid "Wi-Fi del laboratorio" --canales 1,6,11`. Puedes repetir `--ssid` y `--bssid`. Debes indicar al menos un SSID o BSSID. Si configuras varias listas, la asociación debe coincidir con un valor de cada una.

Abre `/adaptador` dentro de un proyecto para consultar radios e interfaces, incluso con alcance pendiente o sin Docker. Usa las flechas y **Enter** para abrir un perfil. Desde allí puedes consultar capacidades, restricciones y avisos. **Actualizar inventario** lee de nuevo el estado del host. **Esc** vuelve sin guardar cambios. Las capacidades anunciadas de monitor y concurrencia se muestran como **no probadas**. La reserva que muestra el panel representa la coordinación local de Harwiff.

Selecciona **Usar este adaptador** para ejecutar el preflight y guardar la selección cuando pase. También funcionan `/adaptador listar`, `/adaptador detalle <nombre>`, `/adaptador usar <nombre>` y `/adaptador <número>`. Por tubería, `/adaptador` muestra el listado textual. `/alcance ver` repite el preflight de la selección guardada. Los ajustes se guardan en `control-wifi.json` junto al manifiesto.

El inventario consulta sysfs, las capacidades declaradas por `nl80211` y los datos de driver y firmware que expone el kernel. El paquete incluye el lector inalámbrico y funciona sin instalar `iw` ni `ethtool`. Las utilidades `ip` (iproute2) y `nmcli` (NetworkManager) aportan estado de conectividad. Si falta una fuente, el inventario muestra los datos parciales con avisos. El preflight conserva el bloqueo operativo cuando faltan comprobaciones de conectividad. Para revisar un equipo físico en modo lectura, abre `/adaptador`, consulta el perfil y las restricciones, pulsa **Actualizar inventario** y vuelve con **Esc**. Puedes hacerlo desde un proyecto nuevo y sin configurar el alcance.

`/diagnostico` usa la selección guardada. Con `mock`, genera un informe sintético. En el flujo físico existente, Harwiff comprueba la reserva local, el alcance y las rutas por defecto IPv4 e IPv6. Si una interfaz del mismo radio sostiene una de esas rutas o la dependencia es indeterminada, bloquea la operación. Lee la asociación desde la caché de NetworkManager y mantiene la reserva hasta terminar.

Harwiff descarga las imágenes fijadas la primera vez que hacen falta. Ejecuta el OpenSandbox incluido bajo un puerto de loopback con una clave efímera. `/config sandbox auto` elige un puerto libre y `/config sandbox <puerto>` fija uno. El colector lee el estado local del adaptador. El sandbox recibe solo indicadores depurados y aplica reglas fijas. La lectura no mide alcance a Internet ni resolución DNS. [OpenSandbox](https://open-sandbox.ai/getting-started/installation)

## Agente y datos del proyecto

### Sesión sobre el escenario mock

En un proyecto de laboratorio, selecciona un modelo con `/connect` o `/model` y prueba este recorrido desde `harwiff >`.

```text
/alcance set --ssid LAB_TEST_AP --canales 6
/adaptador usar mock
/agente Revisar la postura de seguridad del AP del laboratorio
```

`/agente` abre una conversación en segundo plano. Desde la fila de agentes, usa **Tab**, las flechas y **Enter** para entrar. Puedes escribir mientras el agente genera texto o ejecuta una herramienta. Pi incorpora los mensajes en orden en la siguiente solicitud permitida. **Incorporado** significa que Harwiff admitió la solicitud localmente. Una interrupción de red posterior puede impedir que el proveedor la reciba. Los mensajes pendientes al cancelar, revocar, agotar el presupuesto o superar el timeout quedan como **no enviados**.

**Esc**, `/volver` y `/salir` regresan a `harwiff >` sin cancelar el turno. En la raíz, `/salir` cierra Harwiff. `/detener` cancela el trabajo activo. Usa `/detalle` para ver los parámetros depurados, la decisión y la evidencia de una herramienta.

El modelo de OpenAI o Foundry seleccionado elige la secuencia de herramientas de Pi y responde usando los datos sintéticos del escenario. Si la carpeta tiene una conexión disponible y un modelo pendiente, `/agente` abre el selector y continúa con el objetivo al confirmar. Si falta la conexión, muestra cómo usar `/connect`. Las sesiones antiguas de Demo quedan disponibles para consulta. La sesión congela el alcance inicial. Un cambio de adaptador o alcance invalida sus operaciones pendientes, incluso si se restaura la configuración anterior.

Durante una sesión `mock`, `consultar_adaptadores` puede leer un resumen depurado del inventario físico del host. La consulta comparte los límites y la autorización del turno. El historial conserva el hecho auditado de la consulta, con cero referencias de evidencia sobre redes.

Puedes continuar una sesión finalizada desde la misma vista o después de reabrir el proyecto. Cada turno tiene su propia auditoría y hasta ocho solicitudes al modelo, ocho intentos de herramienta y 120 segundos. Reutilizar una evidencia histórica exige validarla contra la auditoría y el alcance vigente. Las sesiones canceladas, interrumpidas o revocadas quedan disponibles para consulta. La ejecución usa el escenario sintético.

### Usar la API oficial de OpenAI

Con un proyecto abierto en `harwiff >`, escribe `/connect`, elige **OpenAI API**, introduce la clave en la entrada oculta y elige el modelo del proyecto en el selector. Si ya tienes una credencial guardada, puedes elegir el modelo directamente con `/model`. Harwiff guarda la clave en Secret Service si `secret-tool` y el almacén de la sesión están disponibles. Si el almacén falla, Harwiff conserva la clave en memoria hasta que cierres el proceso. El proyecto guarda únicamente el proveedor y el modelo.

`/connect` permite cambiar la credencial, probar la conexión o desconectar. `/model` abre el catálogo con la credencial existente. También puedes escribir `/model gpt-6-luna`, `/model azure-foundry/<deployment>` o `/model demo`. El modelo predeterminado se muestra en la cabecera de Capa 1 y se aplica a las sesiones nuevas. Cada sesión conserva su modelo original al continuar.

`/connect list` muestra la configuración y el origen local de la credencial. Harwiff usa primero una clave recién conectada en el proceso, después `OPENAI_API_KEY` si está definida y, por último, Secret Service. `/disconnect openai` desvincula la clave de Harwiff y del almacén de ese usuario. La variable externa sigue disponible. El selector también permite configurar Azure AI Foundry con el dominio, el deployment y `FOUNDRY_API_KEY`.

`/connect test` comprueba autenticación, acceso al modelo y function calling en Responses. Hace una solicitud de generación facturable y muestra sus tokens por separado. El agente elige sus propias herramientas durante `/agente`. [Function calling de OpenAI](https://developers.openai.com/api/docs/guides/function-calling)

Para servidores y automatización, inicia Harwiff con `OPENAI_API_KEY` en el entorno y usa `/model <id>`. En Bash puedes leer la clave sin mostrarla ni incluirla en el historial de comandos.

```bash
read -rsp 'Clave de OpenAI: ' OPENAI_API_KEY
export OPENAI_API_KEY
printf '\n'
npm start
```

Este ejemplo usa `gpt-6-luna` si la cuenta tiene acceso. Si ya lo seleccionaste mediante `/model`, empieza por definir el alcance.

```text
/model gpt-6-luna
/alcance set --ssid LAB_TEST_AP --canales 6
/adaptador usar mock
/agente Revisa la postura de seguridad del AP de laboratorio y resume la evidencia del fixture
```

`/model` muestra todos los IDs que OpenAI devuelve para el proyecto, con los más recientes al principio cuando la API informa su fecha. Harwiff comprueba el acceso al guardar el ID y al iniciar la sesión. Para usar `/agente`, el modelo elegido debe admitir Responses y function calling. Puedes comprobarlo con `/connect test`. Los comandos `/config proveedor`, `/config modelos` y `/config modelo` siguen disponibles para flujos existentes. [Disponibilidad de modelos en OpenAI](https://developers.openai.com/api/docs/guides/rate-limits#model-availability)

El catálogo indica qué IDs están listados, comprobados o confirmados como incompatibles. Harwiff recuerda esas comprobaciones durante el proceso actual para esa credencial y proyecto API. La selección de un ID listado no consume tokens.

Responses usa `store: false`. Durante un turno, Pi puede devolver al proveedor el estado cifrado asociado a sus llamadas junto con sus resultados. Harwiff descarta ese estado al cerrar cada turno. Al continuar, incluso en el mismo proceso, el modelo recibe los mensajes visibles y las evidencias verificadas como contexto y empieza con un estado de razonamiento nuevo. Harwiff solo solicita resúmenes cuando OpenAI documenta esa capacidad para el modelo y muestra por separado los resúmenes oficiales que entregue el proveedor. La documentación de `gpt-6-luna` confirma Responses y function calling. Harwiff conserva ese flujo y señala que el resumen sigue sin confirmar para ese modelo. [Razonamiento en Responses](https://developers.openai.com/api/docs/guides/reasoning#keeping-reasoning-items-in-context)

El resultado y la vista de cada turno incluyen el ID solicitado, los IDs devueltos y los tokens informados por Responses. Una medición parcial indica que alguna solicitud carece de cifras. Desde el repositorio, `node tests/openai.mjs` ejecuta la simulación. El fixture de `gpt-4.1-mini` reporta 101 tokens de entrada, 22 de salida y 123 en total, todos simulados.

La prueba real voluntaria usa `npm run test:openai -- gpt-4.1-mini` o el ID compatible elegido. Con una clave en el entorno o en Secret Service, hace una comprobación facturable de conectividad y luego dos turnos agénticos en un proyecto temporal, con reapertura de la sesión entre ambos. Reporta los consumos por separado, registra la secuencia inicial y verifica la ejecución de una herramienta tras recuperar el contexto. Sin credencial, la prueba se omite. [Streaming de Responses](https://developers.openai.com/api/docs/guides/streaming-responses)

### Chat e informes guardados

En un proyecto Azure Foundry, indica `/config <dominio Azure> <deployment>` e inicia Harwiff con `FOUNDRY_API_KEY` en el entorno. El deployment debe admitir Chat Completions v1 y herramientas. Usa `/connect` para configurar el deployment. `agent harwiff <id>` permite abrir una sesión existente. [Chat Completions](https://learn.microsoft.com/en-us/azure/foundry/openai/latest)

- `auditoria/` contiene la solicitud previa y el resultado por ejecución. Un inicio sin resultado se muestra como pendiente de cierre. Cada llamada de la sesión mock incluye un ID local de correlación, parámetros normalizados, decisión `ALLOWED` o `DENIED`, motivo y referencias de evidencia. Los campos de texto libre se marcan como omitidos en la auditoría.
- `informes/` contiene el JSON de cada diagnóstico con la referencia y SHA-256 en su registro. Los informes de sesiones existentes siguen disponibles como evidencia histórica.
- `agentes/` contiene sesiones del agente con su historial y estado. `sesiones/` conserva las notas e informes de las sesiones de trabajo existentes.

## Desarrollo

Usa Node.js 22.23.5, Python 3.12 y `uv`. Ejecuta `npm ci --ignore-scripts` y `npm start`. El entorno de desarrollo usa el Python del sistema o el intérprete indicado en `WIFI_PYTHON`. Para probar el modo real en desarrollo, instala `requirements-runtime.txt` en ese intérprete. `scripts/build-release.sh` genera los artefactos. [Atribuciones y licencias](THIRD_PARTY.md)
