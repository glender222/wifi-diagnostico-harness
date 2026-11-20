# Harwiff

**Diagnóstico Wi‑Fi de solo lectura desde la terminal.** Abre un proyecto, inspecciona sus adaptadores y conversa con el agente sobre observaciones que puedes verificar en auditoría.

[Instalar](#instalación) · [Primera prueba](#primera-prueba-sin-docker) · [Agente](#conversar-con-el-agente) · [Diagnóstico físico](#diagnóstico-físico) · [Descargas](https://github.com/glender222/wifi-diagnostico-harness/releases/latest)

## Inspección Wi-Fi con el agente

Para usar tu tarjeta habitualmente, elige **Adaptadores → tu radio → Seleccionar para Agentes**. En **Agentes → Nueva conversación**, Harwiff abre el chat con esa interfaz. Si el proyecto está sin interfaz seleccionada, puedes conversar sobre el inventario del host. En la consola, `/agente <objetivo>` inicia una conversación con ese objetivo.

En la consola, pulsa **Tab** con la línea vacía o escribe `/agente` para abrir el menú **Agentes**. Allí también puedes elegir **Abrir sesión guardada** si el proyecto tiene conversaciones.

Para una consulta puntual, usa **Adaptadores → tu radio → Inspeccionar en solo lectura** o **Diagnóstico → Consulta Wi-Fi puntual**. **Solo datos del host** inicia el resumen de la interfaz de inmediato, incluso si la tarjeta sostiene la ruta principal. Las preguntas de seguimiento se hacen en **Agentes**.

```text
/agente --inspeccion -- ¿Qué radios Wi-Fi detectas?
/agente --inspeccion --interfaz wlp1s0 -- ¿Qué rutas IPv4 e IPv6 observas?
/agente --inspeccion --interfaz wlp1s0 --red-del-proyecto -- Describe la asociación autorizada.
/agente --inspeccion --historial -- Recupera la evidencia con ID <id-de-auditoría>.
```

Sustituye `wlp1s0` por la interfaz elegida. La selección de inspección admite la tarjeta que sostiene la ruta principal y las consultas de host funcionan sin configurar un SSID. `--red-del-proyecto` habilita datos de asociación cuando el enlace coincide con el alcance guardado. La evidencia se consulta en `/auditoria <id>`. Para recuperar una evidencia histórica de enlace, repite la selección de interfaz y permisos originales.

La inspección usa el proveedor configurado en el proyecto. Para usar otro adaptador de Pi compatible, establece `HARWIFF_LLM_PROVIDER` y `HARWIFF_LLM_MODEL` al iniciar Harwiff y configura las credenciales de ese proveedor mediante su mecanismo habitual. También puedes guardar `provider`, `model` y, cuando haga falta, `contextWindow` bajo `llm.inspeccion` en el manifiesto. El recorrido exige una comprobación sintética de tool calling antes de consultar el hardware. Los hechos se muestran con citas verificables y las interpretaciones se presentan como hipótesis con sus límites.

El paquete Linux y el entorno de desarrollo incluyen el validador Python. Consulta [Desarrollo](#desarrollo) para preparar el checkout y ejecutar las pruebas simuladas o físicas.

## Instalación

El paquete es para **Linux x86‑64 con glibc**. Incluye Node.js, Python, el lector Wi‑Fi nativo, Pi y OpenSandbox. El instalador verifica el SHA‑256 del paquete, instala sin `sudo` y activa el comando en `~/.local/bin/harwiff`.

```bash
curl -fsSLo /tmp/harwiff-install.sh \
  https://github.com/glender222/wifi-diagnostico-harness/releases/latest/download/install.sh
bash /tmp/harwiff-install.sh
~/.local/bin/harwiff --version
```

Si `harwiff` no aparece en tu `PATH`, puedes ejecutarlo con `~/.local/bin/harwiff`. Ejecutar el instalador de nuevo actualiza el comando y conserva los proyectos en sus respectivas carpetas. Cada paquete indica su versión, canal y commit con `harwiff --version`.

| Modo | Requisitos adicionales | Resultado |
| --- | --- | --- |
| Inventario local | Linux con adaptador Wi‑Fi para ver un radio físico | Dispositivos, interfaces, capacidades anunciadas y avisos |
| Diagnóstico físico | Docker operativo, NetworkManager, iproute2 y adaptador seleccionado | Indicadores de solo lectura procesados con OpenSandbox |
| Conversación con agente | Un proveedor y modelo compatible con llamadas a herramientas | Chat persistente y respuestas con citas a lecturas del host |

## Primera prueba sin Docker

```bash
mkdir -p ~/laboratorio-wifi
cd ~/laboratorio-wifi
harwiff
```

1. Elige **Inicializar esta carpeta** y pulsa **Enter**.
2. Abre **Adaptadores** y selecciona tu radio para ver las interfaces y capacidades que anuncia.
3. Elige **Seleccionar para Agentes** en la interfaz que quieras usar.

Usa **↑** y **↓** para moverte, **Enter** para abrir y **Esc** para volver. **?** abre Ayuda en el menú principal. La TUI admite ventanas desde 60×16. En el chat, a partir de 120 columnas, la actividad aparece a la derecha.

## Conversar con el agente

1. En **Modelo y ajustes**, conecta un proveedor y elige el modelo.
2. Abre **Agentes → Nueva conversación** y escribe «¿Qué rutas por defecto IPv4 e IPv6 observas?».
3. Escribe otra pregunta en el mismo chat. Harwiff envía contexto reciente del mismo alcance y verifica las citas del turno.

**Esc** vuelve a Agentes. **Abrir sesión guardada** recupera la conversación después de reiniciar. **Tab** abre **Detalle de turnos**, **Detener turno** cuando está activo y **Datos del próximo mensaje**. Para consultar la asociación, configura una red autorizada y habilita **Incluir la asociación autorizada del proyecto** antes de enviar ese mensaje.

### Proveedores

- **OpenAI API**. Introduce la clave en el campo oculto de **Conexiones de proveedor** o usa `OPENAI_API_KEY`. Harwiff puede conservar la clave en Secret Service. Si el almacén falla, la clave recién conectada permanece en memoria hasta cerrar la aplicación. El modelo debe admitir Responses y llamadas a herramientas.
- **Azure AI Foundry**. Exporta `FOUNDRY_API_KEY` en la terminal desde la que arrancas Harwiff. Después configura el dominio y el deployment en **Conexiones de proveedor → Azure AI Foundry**. El deployment debe admitir Chat Completions v1 y herramientas.

**Probar conexión** hace una solicitud al proveedor que puede consumir tokens. La conversación usa el modelo que el proyecto tiene configurado al enviar cada mensaje.

## Diagnóstico físico

Abre **Adaptadores** para consultar radios, interfaces, restricciones y capacidades anunciadas por el kernel. El lector usa sysfs y `nl80211`. Puede mostrar un inventario parcial cuando falte una fuente. Las capacidades anunciadas de monitor y concurrencia aparecen como **sin pruebas operativas**.

1. Guarda los SSID o BSSID autorizados y, si corresponde, los canales en **Alcance**. Cada lista configurada debe coincidir con la asociación observada.
2. En **Adaptadores**, abre el radio, revisa las restricciones y elige **Usar para diagnóstico físico**. Harwiff guarda la selección cuando supera el preflight.
3. Con Docker, NetworkManager e iproute2 operativos, abre **Diagnóstico → Ejecutar en modo físico**. El informe y su verificación quedan en **Auditoría**.

Harwiff bloquea la operación si el radio sostiene una ruta por defecto IPv4 o IPv6, o si no puede verificar esa dependencia. El colector consulta la asociación local y envía indicadores depurados a OpenSandbox. La lectura cubre el estado local informado por NetworkManager. El diagnóstico no mide acceso a Internet ni resolución DNS. En el primer uso físico se descargan las imágenes de contenedor fijadas por el proyecto. [OpenSandbox](https://open-sandbox.ai/getting-started/installation)

## Proyectos, notas y automatización

Los proyectos nuevos guardan sus datos en `.harwiff/`. Se reconocen también proyectos anteriores con `harness.json` en la raíz. Abre **Proyectos → Abrir proyecto** para buscar en una carpeta. En **Sesiones de trabajo** puedes organizar notas y contexto técnico.

| Ruta relativa al proyecto de Harwiff | Contenido |
| --- | --- |
| `harness.json` y `control-wifi.json` | Configuración, adaptador y alcance |
| `informes/` y `auditoria/` | Informes JSON, resultados y referencias de evidencia |
| `agentes/` y `sesiones/` | Conversaciones y notas de trabajo |

**Ayuda → Consola de comandos** abre la vista de comandos. El listado por ruta y la entrada por tubería sirven para scripts.

```bash
harwiff proyectos --json --profundidad 2 "$HOME/Proyectos"
printf '%s\n' '/adaptador listar' '/auditoria' '/salir' | harwiff ~/laboratorio-wifi
```

El lote mantiene los resultados en stdout, escribe los errores en stderr y devuelve código 1 si alguna línea falla. El ejemplo supone un proyecto ya inicializado.

## Desarrollo

Usa la rama `mvp-entorno` para trabajar con el código fuente. Activa la versión de Node.js indicada en `.node-version` y ten `uv` disponible. El lanzador prepara el Python fijado en `.python-version` dentro de `.venv-dev` e instala las dependencias de ambos lenguajes desde sus archivos de versiones.

```bash
git clone --branch mvp-entorno https://github.com/glender222/wifi-diagnostico-harness.git harwiff-mvp
cd harwiff-mvp
./scripts/harwiff-dev --setup
./scripts/harwiff-dev --version
```

Si ya tienes el checkout, puedes actualizarlo con `git pull --ff-only` desde `mvp-entorno`. Repite `--setup` al cambiar las versiones o dependencias. Para invocar el lanzador desde cualquier carpeta, añade un enlace desde el checkout que vas a usar.

```bash
mkdir -p "$HOME/.local/bin"
ln -s "$PWD/scripts/harwiff-dev" "$HOME/.local/bin/harwiff-dev"
```

En cada arranque, `harwiff-dev` lee el código del checkout al que apunta. Reabre el programa después de editar. Puedes indicar la carpeta de un proyecto como argumento. Las dependencias de desarrollo, los proyectos locales `.harwiff/` y los artefactos de compilación se excluyen de Git.

| Prueba | Comando desde el checkout | Verificación |
| --- | --- | --- |
| Suite local y de CI | `./scripts/harwiff-dev --test` | Contratos, políticas, proveedores simulados, CLI y TUI. Usa proyectos temporales y funciona sin credenciales. |
| Wi-Fi real con LLM simulado | `./scripts/harwiff-dev --test-host` | Lee la ruta IPv4 de una tarjeta PCIe que sostiene la conexión principal. Requiere Linux e iproute2. |
| Conversación manual con LLM real | `./scripts/harwiff-dev <carpeta-del-proyecto>` | Abre **Agentes → Nueva conversación**, envía dos preguntas sobre el enlace y vuelve a abrir la sesión. Revisa las citas en **Auditoría**. |

Para comprobar el inventario local, inicializa un proyecto temporal y lista los adaptadores.

```bash
prueba="$(mktemp -d)"
printf '%s\n' '/init' '/adaptador listar' '/salir' | ./scripts/harwiff-dev "$prueba"
```

El runner de aceptación con un LLM real se ejecuta con `.venv-dev/bin/python3` como `WIFI_PYTHON`.

```bash
WIFI_PYTHON="$PWD/.venv-dev/bin/python3" node tests/inspeccion-real.mjs "$HOME/laboratorio-wifi" wlp1s0
```

Sustituye la ruta y la interfaz por las de tu equipo. Esa prueba requiere que la asociación actual esté autorizada en el proyecto. Agrega `--usb` para el perfil del segundo equipo. El runner registra los resultados automáticos para revisar luego las interpretaciones.

Para verificar el paquete que se instala en otros equipos, compílalo y ejecuta la prueba de instalación. CI prueba también la instalación limpia en Ubuntu 22.04 y Debian 12.

```bash
artefactos="$(mktemp -d)"
./scripts/build-release.sh "$artefactos"
bash tests/instalacion.sh "file://$artefactos"
```

[Acciones de GitHub](https://github.com/glender222/wifi-diagnostico-harness/actions) · [Atribuciones y licencias](THIRD_PARTY.md)
