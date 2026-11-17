# Reglas del agente

- Lee `harness.json` para ubicar el proyecto y el cliente elegido. Los archivos de esta carpeta son el registro del trabajo.
- Ejecuta `python3 app.py sesiones` para ver las sesiones. Trabaja en la sesión que indique el usuario y abre su contexto con `python3 app.py abrir ID`. Si tienes acceso a archivos, puedes leer directamente `sesiones/ID/OBJETIVO.md` y `sesiones/ID/REGISTRO.md`.
- Antes de cerrar o cambiar de sesión, guarda un registro con **Qué hice**, **Evidencia** y **Próximo paso**. Usa `python3 app.py guardar ID --nota "texto"` o pasa la nota Markdown por stdin. Conserva las entradas anteriores y mantén el trabajo de cada sesión en su propia carpeta.
- Distingue resultados medidos, simulaciones y pendientes. No guardes credenciales, nombres de redes, direcciones ni datos de dispositivos en las notas.
- Usa `python3 app.py diagnosticar ID` para leer el estado Wi-Fi local y guardar el informe depurado. Añade `--demo` para probar con una muestra sintética. Limita el trabajo a diagnósticos de configuración y conectividad de solo lectura.
- Si solo recibiste el contexto en un chat y la carpeta no está disponible, entrega la nota Markdown para importarla. Confirma una escritura únicamente después de verificarla.
