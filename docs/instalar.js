const button = document.querySelector("[data-copy]");
const command = document.getElementById(button.dataset.copy);
const status = document.getElementById("estado-copia");
let reset;

button.hidden = false;
button.addEventListener("click", async () => {
  clearTimeout(reset);

  try {
    await navigator.clipboard.writeText(command.textContent);
    button.textContent = "Copiado";
    status.textContent = "Comando de instalación copiado.";
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(command);
    selection.removeAllRanges();
    selection.addRange(range);
    button.textContent = "Seleccionado";
    status.textContent = "Comando seleccionado. Usa Ctrl+C o Cmd+C para copiarlo.";
  }

  reset = setTimeout(() => {
    button.textContent = "Copiar";
    status.textContent = "";
  }, 3500);
});
