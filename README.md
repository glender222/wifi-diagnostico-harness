# Harwiff

Harwiff es un entorno de diagnóstico Wi-Fi por proyecto. Guarda las lecturas de solo lectura, notas e historial del agente y vincula cada operación con su evidencia.

## Instalar en Linux x86-64

```bash
curl -fsSL https://github.com/glender222/wifi-diagnostico-harness/releases/download/v0.2.4/install.sh | bash
```

El instalador verifica el SHA-256 y coloca el comando en `~/.local/bin/harwiff`. Si esa carpeta no está en tu `PATH`, lanza `~/.local/bin/harwiff` o añade `~/.local/bin` al `PATH`. La release incluye Node.js, Python, el loop de Pi y el servidor y SDK de OpenSandbox. El diagnóstico real requiere Docker operativo y NetworkManager. [GitHub Releases](https://github.com/glender222/wifi-diagnostico-harness/releases)

## Probar

1. Ejecuta `harwiff`. En `wifi >`, escribe `/proyecto` y pulsa **Enter** para usar la carpeta actual, o escribe otra ruta. `/proyecto .` usa la carpeta actual directamente. Los proyectos nuevos usan demo por defecto.
2. En `wifi >`, escribe `/diagnostico demo` para generar un informe sintético. `/auditoria` muestra su ID y `/auditoria <id>` muestra el detalle y la evidencia.
3. En un proyecto demo o Foundry, escribe una consulta en `wifi >` y pulsa **Enter**. La vista y la fila de agentes aparecen al enviar la primera consulta. `agent harwiff <id>` permite elegir una sesión. **Esc** vuelve al entorno mientras el agente trabaja. Con el editor vacío, **Tab**, las flechas y **Enter** permiten cambiar de sesión. Dentro del agente, `/config` muestra su configuración y `/detener` cancela el turno.
4. Sal con `/salir` o **Ctrl+D** con el editor vacío. Al volver, `agent harwiff` recupera la sesión más reciente. Las consultas interrumpidas se muestran para reenviarlas manualmente.

En carpetas de trabajo existentes, Harwiff guarda sus datos dentro de `.harwiff/` y conserva tus archivos. Harwiff abre automáticamente un proyecto existente en la carpeta actual, o puedes pasarlo con `harwiff ruta/al/proyecto`. Para crear un proyecto Foundry usa `/proyecto --foundry mi-proyecto`. Para crear o retomar una sesión de trabajo y guardar notas manuales usa `/nueva`, `/abrir`, `/guardar` y `/contexto`. Escribe `/` para ver el menú de comandos de la vista actual o `/ayuda` para listarlos.

## Diagnóstico real

`/adaptador` lista los dispositivos reconocidos por NetworkManager, identifica si son USB o integrados cuando Linux lo permite y muestra la conexión activa. `/adaptador <número>` guarda la selección física. Ejecuta `/diagnostico` desde `wifi >`.

Harwiff descarga las imágenes fijadas la primera vez que hacen falta. Ejecuta el OpenSandbox incluido bajo un puerto de loopback con una clave efímera. `/config sandbox auto` elige un puerto libre y `/config sandbox <puerto>` fija uno. El colector lee el estado local del adaptador. El sandbox recibe solo indicadores depurados y aplica reglas fijas. La lectura no mide alcance a Internet ni resolución DNS. [OpenSandbox](https://open-sandbox.ai/getting-started/installation)

## Agente y datos del proyecto

En un proyecto Azure Foundry, indica `/config <dominio Azure> <deployment>` e inicia Harwiff con `FOUNDRY_API_KEY` en el entorno. El deployment debe admitir Chat Completions v1 y herramientas. El agente puede consultar informes guardados. Usa `/diagnostico` en el entorno para generar una lectura real. En proyectos previos de ChatGPT y OpenCode, el cliente externo conserva su flujo y `agent harwiff --demo` abre el agente local de prueba. [Chat Completions](https://learn.microsoft.com/en-us/azure/foundry/openai/latest)

- `auditoria/` contiene la solicitud previa y el resultado por ejecución. Un inicio sin resultado se muestra como pendiente de cierre.
- `informes/` contiene el JSON de cada diagnóstico con la referencia y SHA-256 en su registro. Los informes de sesiones existentes siguen disponibles como evidencia histórica.
- `agentes/` contiene sesiones del agente con su historial y estado. `sesiones/` conserva las notas e informes de las sesiones de trabajo existentes.

## Desarrollo

Usa Node.js 22.23.5, Python 3.12 y `uv`. Ejecuta `npm ci --ignore-scripts` y `npm start`. El entorno de desarrollo usa el Python del sistema o el intérprete indicado en `WIFI_PYTHON`. Para probar el modo real en desarrollo, instala `requirements-runtime.txt` en ese intérprete. `scripts/build-release.sh` genera los artefactos. [Atribuciones y licencias](THIRD_PARTY.md)
