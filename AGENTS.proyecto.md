# Reglas del agente

- Lee `harness.json` para ubicar el proyecto y el cliente elegido. Los archivos de esta carpeta son el registro del trabajo.
- Usa `/sesiones` en `harwiff >` para ver las sesiones de trabajo y `/abrir ID` para consultar su contexto. Trabaja en la sesión que indique el usuario. También puedes leer `sesiones/ID/OBJETIVO.md` y `sesiones/ID/REGISTRO.md` desde esta carpeta de datos.
- Antes de cerrar o cambiar de sesión, guarda un registro con **Qué hice**, **Evidencia** y **Próximo paso**. Usa `/guardar <nota>` en `harwiff >`. Conserva las entradas anteriores y mantén el trabajo de cada sesión en su propia carpeta.
- En un proyecto con una copia local de `app.py`, también puedes usar `python3 app.py sesiones`, `python3 app.py abrir ID` y `python3 app.py guardar ID --nota "texto"`.
- Distingue resultados medidos, simulaciones y pendientes. No guardes credenciales, nombres de redes, direcciones ni datos de dispositivos en las notas.
- Si solo recibiste el contexto en un chat y la carpeta no está disponible, entrega la nota Markdown para importarla. Confirma una escritura únicamente después de verificarla.

Los diagnósticos administrados se ejecutan desde `harwiff >` con `/diagnostico`. Para citar una lectura, usa su ID de `/auditoria`. En **Agentes → Nueva conversación**, Harwiff puede consultar el host en solo lectura y recuperar evidencia previa del mismo alcance.
